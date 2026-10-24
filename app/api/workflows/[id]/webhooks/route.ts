import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { apiError } from "@/lib/api-error";
import {
  getOrCreateWebhookEndpoint,
  getWebhookEndpoint,
  webhookUrl,
  WebhookEndpointError,
} from "@/server/webhooks/endpoint-repository";

/**
 * Fase 5A — a URL de um Webhook Trigger, para o painel do nó.
 *
 *   GET  ?nodeId=...      200 { url | null }
 *   POST { nodeId }       200 { url }   (idempotente: devolve a mesma URL)
 *
 * O workspace vem do usuário autenticado, nunca da request.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nodeIdSchema = z.string().min(1).max(200);

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);
  if (!UUID.test(params.id)) {
    return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
  }
  const nodeId = nodeIdSchema.safeParse(request.nextUrl.searchParams.get("nodeId"));
  if (!nodeId.success) return apiError("VALIDATION_ERROR", "nodeId is required", 400);

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");
  const endpoint = await getWebhookEndpoint(user.id, workspaceId, params.id, nodeId.data);
  return NextResponse.json({ url: endpoint ? webhookUrl(endpoint.token) : null });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);
  if (!UUID.test(params.id)) {
    return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = z.object({ nodeId: nodeIdSchema }).safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "nodeId is required", 400);

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");
  try {
    const endpoint = await getOrCreateWebhookEndpoint(
      user.id,
      workspaceId,
      params.id,
      parsed.data.nodeId
    );
    if (!endpoint) {
      return apiError("WEBHOOK_CREATE_FAILED", "Unable to create the webhook URL", 500);
    }
    return NextResponse.json({ url: webhookUrl(endpoint.token) });
  } catch (err) {
    if (err instanceof WebhookEndpointError) {
      return apiError(err.code, err.message, err.code === "WORKFLOW_NOT_FOUND" ? 404 : 409);
    }
    throw err;
  }
}
