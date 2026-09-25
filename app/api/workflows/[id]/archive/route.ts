import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { archiveWorkflow } from "@/server/workflows/mutations";
import { WorkflowConflictError } from "@/server/workflows/errors";
import { apiError } from "@/lib/api-error";

interface RouteParams {
  params: { id: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fase 10.5A — archive a workflow instead of deleting it.
 *
 *   200 { workflow }  archived now, or already archived (idempotent)
 *   404               not found in the caller's workspace
 *   409 WORKFLOW_HAS_ACTIVE_EXECUTIONS  queued/running WORKER executions exist
 *
 * The workspace comes from the authenticated user, never from the request.
 * See server/workflows/mutations.ts#archiveWorkflow for what archiving
 * guarantees and how the race with a concurrent Execute is closed.
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
    const result = await archiveWorkflow(user.id, workspaceId, params.id);
    if (result.outcome === "not_found") {
      return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
    }
    return NextResponse.json({ workflow: result.workflow });
  } catch (err) {
    if (err instanceof WorkflowConflictError) return apiError(err.code, err.message, 409);
    return apiError("WORKFLOW_ARCHIVE_FAILED", "Unable to archive this workflow. Please try again.", 500);
  }
}
