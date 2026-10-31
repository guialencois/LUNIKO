import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { serverEnv } from "@/lib/env";
import { buildExecutionPlan } from "@/lib/execution/planner";
import { ExecutionEngineError, ExecutionErrorCode } from "@/lib/execution/errors";
import { EXECUTION_LIMITS, type ExecutionItem } from "@/lib/execution/types";
import { webhookTriggerConfigSchema } from "@/lib/workflows/definitions/webhook-trigger";
import { isValidMetaSignature } from "@/lib/whatsapp/signature";
import { parseWhatsappWebhook } from "@/lib/whatsapp/parse";
import { buildGenericItems, buildWhatsappItems, type IncomingHttpRequest } from "@/lib/webhooks/payload";
import { createWebhookExecution } from "@/server/execution/execution-repository";
import { refusingArchived } from "@/server/execution/workflow-archived";
import { findEndpointByToken } from "./endpoint-repository";

/**
 * Fase 5A — o que acontece quando alguém chama /api/hooks/<token>.
 * Ver docs/webhook-trigger.md para cada decisão.
 *
 * Nunca executa o workflow aqui: no máximo enfileira. A resposta sai na
 * hora, e o worker roda o resto.
 */

export interface WebhookResponse {
  status: number;
  body: unknown;
  /** text/plain só para o desafio da Meta, que espera o valor puro. */
  contentType?: "text/plain";
}

export interface IncomingWebhookRequest extends IncomingHttpRequest {
  signature: string | null;
}

// 32 bytes em base64url = 43 caracteres. Qualquer outra coisa nem consulta o banco.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,64}$/;

function fail(status: number, code: string, message: string): WebhookResponse {
  return { status, body: { error: { code, message } } };
}

// Uma resposta só para "não existe", seja qual for o motivo: token errado,
// workflow arquivado, nó removido, autor sem acesso. Quem está de fora não
// aprende nada sobre o que existe do lado de cá.
const NOT_FOUND = () => fail(404, "WEBHOOK_NOT_FOUND", "Not found");

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export async function receiveWebhook(
  token: string,
  request: IncomingWebhookRequest
): Promise<WebhookResponse> {
  if (!TOKEN_SHAPE.test(token)) return NOT_FOUND();

  const endpoint = await findEndpointByToken(token);
  if (!endpoint) return NOT_FOUND();

  // O workflow sai do endpoint, nunca da request.
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, endpoint.workflowId), eq(workflows.workspaceId, endpoint.workspaceId)))
    .limit(1);
  if (!workflow || workflow.archivedAt) return NOT_FOUND();

  // O documento ATUAL: é ele que vira o snapshot desta execução.
  const document = workflow.document as { nodes?: { id: string; type: string; data?: unknown }[] };
  const node = document.nodes?.find((n) => n.id === endpoint.nodeId);
  if (!node || node.type !== "webhookTrigger") return NOT_FOUND();

  const config = webhookTriggerConfigSchema.safeParse(node.data ?? {});
  if (!config.success) {
    return fail(422, "WEBHOOK_CONFIG_INVALID", "The Webhook Trigger configuration is invalid");
  }

  let items: ExecutionItem[];
  let dedupeKey: string | null = null;

  if (config.data.provider === "whatsapp") {
    // ---- Protocolo da Meta, antes de qualquer workflow ----
    if (request.method === "GET") {
      const verifyToken = serverEnv.WHATSAPP_VERIFY_TOKEN;
      if (!verifyToken) {
        return fail(503, "WHATSAPP_NOT_CONFIGURED", "WHATSAPP_VERIFY_TOKEN is not set.");
      }
      const { "hub.mode": mode, "hub.verify_token": presented, "hub.challenge": challenge } =
        request.query;
      if (mode === "subscribe" && presented && challenge && sameSecret(presented, verifyToken)) {
        return { status: 200, body: challenge, contentType: "text/plain" };
      }
      return fail(403, "FORBIDDEN", "Verification failed");
    }

    if (request.method !== "POST") {
      return fail(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }

    const appSecret = serverEnv.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      return fail(503, "WHATSAPP_NOT_CONFIGURED", "WHATSAPP_APP_SECRET is not set.");
    }
    if (!isValidMetaSignature(request.rawBody, request.signature, appSecret)) {
      return fail(401, "INVALID_SIGNATURE", "Invalid signature");
    }

    let body: unknown;
    try {
      body = JSON.parse(request.rawBody);
    } catch {
      return fail(400, "INVALID_JSON", "Request body must be valid JSON");
    }

    const parsed = parseWhatsappWebhook(body);
    // 200 nos dois casos abaixo: assinado e legítimo, só não há nada para
    // rodar. Qualquer outra resposta faria a Meta reenviar.
    if (!parsed.isWhatsappPayload) {
      return { status: 200, body: { ignored: "not_whatsapp" } };
    }
    if (parsed.messages.length === 0) {
      return { status: 200, body: { ignored: "no_messages" } };
    }

    items = buildWhatsappItems(parsed.messages);
    // A Meta reenvia o MESMO corpo quando não recebe 200 a tempo.
    dedupeKey = `whatsapp:${endpoint.id}:${createHash("sha256").update(request.rawBody, "utf8").digest("hex")}`;
  } else if (config.data.provider === "instagram") {
    // Existe no editor (webhook-trigger.ts) mas não aqui ainda — ver o
    // comentário lá. 501 explícito em vez de cair no branch genérico: o
    // genérico aceitaria o GET do desafio da Meta como se fosse um
    // request comum e nunca devolveria o challenge, então a verificação
    // do webhook no painel da Meta falharia de um jeito confuso em vez de
    // dizer claramente "ainda não dá para usar isso".
    return fail(501, "NOT_IMPLEMENTED", "Instagram webhook support is not implemented yet.");
  } else {
    if (request.method !== config.data.method) {
      return fail(405, "METHOD_NOT_ALLOWED", `This webhook only accepts ${config.data.method}`);
    }
    items = buildGenericItems(request);
  }

  if (items.length > EXECUTION_LIMITS.MAX_ITEMS_PER_NODE) {
    return fail(413, "LIMIT_EXCEEDED", "Too many items in one request");
  }

  // Validação, como no Execute: um workflow quebrado não entra na fila.
  try {
    buildExecutionPlan(workflow.id, workflow.document, { type: "webhook", nodeId: node.id });
  } catch (err) {
    if (err instanceof ExecutionEngineError) {
      return fail(422, err.code, err.message);
    }
    throw err;
  }

  let execution;
  try {
    execution = await refusingArchived(() =>
      createWebhookExecution({
        endpointCreatedBy: endpoint.createdBy,
        workspaceId: endpoint.workspaceId,
        workflowId: workflow.id,
        triggerNodeId: node.id,
        document: workflow.document,
        items,
        dedupeKey,
      })
    );
  } catch (err) {
    if (err instanceof ExecutionEngineError && err.code === ExecutionErrorCode.WORKFLOW_ARCHIVED) {
      return NOT_FOUND();
    }
    // requireWorkspaceMembership: quem gerou a URL não é mais membro.
    if (err instanceof Error && err.message.startsWith("FORBIDDEN")) {
      return NOT_FOUND();
    }
    throw err;
  }

  if (!execution) {
    return { status: 200, body: { duplicate: true } };
  }
  return { status: 200, body: { executionId: execution.id, status: "queued" } };
}
