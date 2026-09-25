import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { listEffectOperations } from "@/server/execution/effects/effect-repository";
import { toEffectOperationView } from "@/server/execution/effects/effect-view";
import type { EffectStatus } from "@/server/execution/effects/effect-decision";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: readonly EffectStatus[] = ["reserved", "in_flight", "succeeded", "failed", "unknown"];

/**
 * Fase 10.5A — external operations of the caller's workspace.
 *
 *   GET /api/effects                   the ones waiting for a person ("unknown")
 *   GET /api/effects?status=failed     any one status
 *   GET /api/effects?status=all        everything, newest first
 *   &limit=1..200 (default 50)
 *
 * The workspace comes from the authenticated user, never from the request.
 * Every member may read; deciding is POST .../resolve, owner/admin only.
 * The shape is effect-view.ts's allowlist.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  const params = request.nextUrl.searchParams;
  const rawStatus = params.get("status") ?? "unknown";
  if (rawStatus !== "all" && !STATUSES.includes(rawStatus as EffectStatus)) {
    return apiError("VALIDATION_ERROR", `status must be one of: all, ${STATUSES.join(", ")}`, 400);
  }
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return apiError("VALIDATION_ERROR", "limit must be an integer between 1 and 200", 400);
  }

  try {
    const rows = await listEffectOperations(user.id, workspaceId, {
      status: rawStatus === "all" ? undefined : (rawStatus as EffectStatus),
      limit,
    });
    return NextResponse.json({ operations: rows.map(toEffectOperationView) });
  } catch {
    return apiError("EFFECTS_LIST_FAILED", "Unable to list external operations", 500);
  }
}
