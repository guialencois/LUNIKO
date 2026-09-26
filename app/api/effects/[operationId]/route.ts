import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { getEffectOperationDetail } from "@/server/execution/effects/effect-repository";
import { toEffectAttemptView, toEffectOperationView } from "@/server/execution/effects/effect-view";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: { operationId: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fase 10.5A — one external operation and its whole history, in order.
 * Not in the caller's workspace, or not an id at all: 404, indistinguishable
 * from "does not exist" (same rule as GET /api/executions/[id]).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  if (!UUID.test(params.operationId)) {
    return apiError("EFFECT_NOT_FOUND", "This operation could not be found", 404);
  }

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  let found;
  try {
    found = await getEffectOperationDetail(user.id, workspaceId, params.operationId);
  } catch {
    return apiError("EFFECT_NOT_FOUND", "This operation could not be found", 404);
  }
  if (!found) return apiError("EFFECT_NOT_FOUND", "This operation could not be found", 404);

  return NextResponse.json({
    operation: toEffectOperationView(found),
    history: found.attempts.map(toEffectAttemptView),
  });
}
