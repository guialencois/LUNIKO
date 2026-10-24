import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookEndpoints } from "@/lib/db/schema";
import { requireWorkspaceMembership } from "@/lib/auth/session";
import { getWorkflowById } from "@/server/workflows/queries";
import { publicEnv } from "@/lib/env";

/**
 * Fase 5A — endpoints de webhook. Ver docs/webhook-trigger.md.
 *
 * As funções com (userId, workspaceId) são do Modelo 1 (usuário vivo, no
 * editor) e revalidam a membership. findEndpointByToken é a única porta de
 * entrada sem usuário: a credencial é o próprio token.
 */

export class WebhookEndpointError extends Error {
  constructor(
    public code: "WORKFLOW_NOT_FOUND" | "WEBHOOK_NODE_NOT_SAVED",
    message: string
  ) {
    super(message);
    this.name = "WebhookEndpointError";
  }
}

export function webhookUrl(token: string): string {
  return `${publicEnv.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/api/hooks/${token}`;
}

function newToken(): string {
  // 32 bytes = 256 bits. base64url tem 43 caracteres e é seguro em URL.
  return randomBytes(32).toString("base64url");
}

/** O nó precisa estar no documento SALVO — o editor pode ter mudanças locais. */
function savedDocumentHasWebhookNode(document: unknown, nodeId: string): boolean {
  const nodes = (document as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some(
    (n) =>
      typeof n === "object" &&
      n !== null &&
      (n as { id?: unknown }).id === nodeId &&
      (n as { type?: unknown }).type === "webhookTrigger"
  );
}

export async function getWebhookEndpoint(
  userId: string,
  workspaceId: string,
  workflowId: string,
  nodeId: string
) {
  await requireWorkspaceMembership(userId, workspaceId);
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.workspaceId, workspaceId),
        eq(webhookEndpoints.workflowId, workflowId),
        eq(webhookEndpoints.nodeId, nodeId)
      )
    )
    .limit(1);
  return endpoint ?? null;
}

/** Idempotente: gerar de novo devolve a mesma URL. */
export async function getOrCreateWebhookEndpoint(
  userId: string,
  workspaceId: string,
  workflowId: string,
  nodeId: string
) {
  const workflow = await getWorkflowById(userId, workspaceId, workflowId);
  if (!workflow || workflow.archivedAt) {
    throw new WebhookEndpointError("WORKFLOW_NOT_FOUND", "This workflow could not be found");
  }
  if (!savedDocumentHasWebhookNode(workflow.document, nodeId)) {
    throw new WebhookEndpointError(
      "WEBHOOK_NODE_NOT_SAVED",
      "Salve o workflow com este Webhook Trigger antes de gerar a URL."
    );
  }

  const existing = await getWebhookEndpoint(userId, workspaceId, workflowId, nodeId);
  if (existing) return existing;

  const [created] = await db
    .insert(webhookEndpoints)
    .values({ workspaceId, workflowId, nodeId, token: newToken(), createdBy: userId })
    // Duas abas clicando ao mesmo tempo: a segunda não cria outra URL.
    .onConflictDoNothing()
    .returning();

  return created ?? (await getWebhookEndpoint(userId, workspaceId, workflowId, nodeId));
}

/** Modelo 3: sem usuário. Só o token identifica. */
export async function findEndpointByToken(token: string) {
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.token, token))
    .limit(1);
  return endpoint ?? null;
}
