import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { listWorkflows } from "@/server/workflows/queries";
import { createWorkflow } from "@/server/workflows/mutations";
import {
  validateCreateWorkflowInput,
  WorkflowValidationError,
} from "@/server/workflows/validation";
import { apiError } from "@/lib/api-error";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  // Fase 10.5A: active workflows unless ?archived=true.
  const archived = request.nextUrl.searchParams.get("archived") === "true";

  try {
    const items = await listWorkflows(user.id, workspaceId, { archived });
    return NextResponse.json({ workflows: items });
  } catch {
    return apiError("WORKFLOWS_LIST_FAILED", "Unable to list workflows", 500);
  }
}

export async function POST(request: NextRequest) {
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
    input = validateCreateWorkflowInput(body);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    throw err;
  }

  try {
    const workflow = await createWorkflow(user.id, workspaceId, input);
    return NextResponse.json({ workflow }, { status: 201 });
  } catch {
    return apiError("WORKFLOW_CREATE_FAILED", "Unable to create workflow", 500);
  }
}
