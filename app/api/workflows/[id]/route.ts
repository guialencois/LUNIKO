import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { getWorkflowById } from "@/server/workflows/queries";
import { updateWorkflow, deleteWorkflow } from "@/server/workflows/mutations";
import {
  validateUpdateWorkflowInput,
  WorkflowValidationError,
} from "@/server/workflows/validation";
import { WorkflowConflictError } from "@/server/workflows/errors";
import { apiError } from "@/lib/api-error";

interface RouteParams {
  params: { id: string };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  const workflow = await getWorkflowById(user.id, workspaceId, params.id);
  if (!workflow) {
    return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
  }

  return NextResponse.json({ workflow });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  let input;
  try {
    input = validateUpdateWorkflowInput(body);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    throw err;
  }

  try {
    const workflow = await updateWorkflow(user.id, workspaceId, params.id, input);
    if (!workflow) {
      return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
    }
    return NextResponse.json({ workflow });
  } catch (err) {
    // Fase 10.5A: an archived workflow is read-only until restored.
    if (err instanceof WorkflowConflictError) return apiError(err.code, err.message, 409);
    return apiError("WORKFLOW_UPDATE_FAILED", "Unable to save workflow. Please try again.", 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  let deleted;
  try {
    deleted = await deleteWorkflow(user.id, workspaceId, params.id);
  } catch (err) {
    // Fase 10.5A: a workflow with external-effect history is archived, not
    // deleted — POST /api/workflows/[id]/archive.
    if (err instanceof WorkflowConflictError) return apiError(err.code, err.message, 409);
    throw err;
  }
  if (!deleted) {
    return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
  }

  return NextResponse.json({ success: true });
}
