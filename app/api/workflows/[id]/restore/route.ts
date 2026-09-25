import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { restoreWorkflow } from "@/server/workflows/mutations";
import { apiError } from "@/lib/api-error";

interface RouteParams {
  params: { id: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fase 10.5A — bring an archived workflow back to the working set.
 *
 *   200 { workflow }  restored now, or was not archived (idempotent)
 *   404               not found in the caller's workspace
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  // Not an id at all: "not found" — never a database error (22P02) as a 500.
  if (!UUID.test(params.id)) {
    return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
  }

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  try {
    const result = await restoreWorkflow(user.id, workspaceId, params.id);
    if (result.outcome === "not_found") {
      return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
    }
    return NextResponse.json({ workflow: result.workflow });
  } catch {
    return apiError("WORKFLOW_RESTORE_FAILED", "Unable to restore this workflow. Please try again.", 500);
  }
}
