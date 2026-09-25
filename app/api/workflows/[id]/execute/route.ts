import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { executeWorkflow } from "@/server/execution/execute-workflow";
import { enqueueWorkflowExecution } from "@/server/execution/enqueue-workflow-execution";
import { QueueError } from "@/server/execution/execution-queue";
import {
  validateExecuteWorkflowRequest,
  ExecuteRequestValidationError,
} from "@/server/execution/validation";
import { ExecutionEngineError } from "@/lib/execution/errors";
import { apiError } from "@/lib/api-error";

interface RouteParams {
  // `id`, like the sibling routes under app/api/workflows/[id]: two dynamic
  // segments with different names at the same level break the Next.js build
  // ("You cannot use different slug names for the same dynamic path"). The
  // public URL is unchanged: POST /api/workflows/<id>/execute.
  params: { id: string };
}

/**
 * Two lifecycles behind one endpoint, chosen by the request's `mode`
 * (default "sync" — see server/execution/validation.ts).
 *
 *   mode "sync"  (default, unchanged since Fase 3)
 *     auth -> workspace -> workflow -> executeWorkflow() -> persistence
 *     -> 200 { executionId, status, result | error }
 *
 *   mode "async" (Fase 4H — the producer side of the queue)
 *     auth -> workspace -> workflow -> validate -> snapshot
 *     -> enqueueWorkflowExecution() -> 202 { executionId, status: "queued" }
 *     Nothing is executed during the request.
 *
 * This route touches neither planner, engine nor repository directly: both
 * branches delegate to a service that enforces workspace membership on
 * every database call it makes. Duplicating any of that here would be the
 * "segundo sistema" the task says not to build — and the async branch in
 * particular must never call processQueuedExecution() as a stand-in for a
 * real consumer, which would just be the synchronous path wearing a queue
 * as a costume.
 *
 * IMPORTANT, AND NOT HIDDEN: nothing consumes this queue in production
 * yet. There is no worker process and no deployment that could host one
 * (the target is serverless), no GET /api/executions/[executionId], and no
 * polling in the editor. An execution created with mode "async" is
 * therefore correctly queued and simply waits. That is why "sync" is still
 * the default and why the editor was not migrated — see the "Consumidor da
 * fila" section in docs/async-execution.md for exactly what is missing.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  // workspaceId is always derived server-side from the authenticated user —
  // never read from the request body, query string, or params. A workflow
  // belonging to a different workspace is simply not found (see
  // executeWorkflow -> getWorkflowById, which already filters by this
  // workspaceId), not distinguished from "doesn't exist" in the response.
  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  let body: unknown = {};
  const rawBody = await request.text();
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    }
  }

  let parsed;
  try {
    parsed = validateExecuteWorkflowRequest(body);
  } catch (err) {
    if (err instanceof ExecuteRequestValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    throw err;
  }

  try {
    if (parsed.mode === "async") {
      const queued = await enqueueWorkflowExecution({
        userId: user.id,
        workspaceId,
        workflowId: params.id,
      });

      // 202 Accepted: the request was accepted for processing and the
      // workflow has NOT run. Distinct from the 200 the sync branch
      // returns, so a client can tell the two apart from the status line
      // alone, without inspecting the body.
      return NextResponse.json(queued, { status: 202 });
    }

    const result = await executeWorkflow({
      userId: user.id,
      workspaceId,
      workflowId: params.id,
      input: parsed.input,
    });

    // The request itself was handled correctly regardless of whether the
    // *workflow* ended in success/error/cancelled — that outcome is
    // communicated in the response body's `status` field (same convention
    // executeWorkflow already returns), not the HTTP status code. Only
    // request-level failures (auth, validation, not-found) use non-200s.
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ExecutionEngineError && err.code === "WORKFLOW_NOT_FOUND") {
      return apiError("WORKFLOW_NOT_FOUND", "This workflow could not be found", 404);
    }
    if (err instanceof ExecutionEngineError && err.code === "WORKFLOW_ARCHIVED") {
      // Fase 10.5A: the workflow exists but is archived — a state conflict
      // the caller can resolve (restore), not a malformed request.
      return apiError("WORKFLOW_ARCHIVED", err.message, 409);
    }
    if (err instanceof QueueError) {
      // Reaching this means the row created a moment earlier was already
      // not queueable — nothing in the current design can do that, so it
      // is a server-side inconsistency, not a client error.
      return apiError(err.code, "Unable to queue this execution. Please try again.", 500);
    }
    if (err instanceof ExecutionEngineError) {
      // Any other ExecutionEngineError reaching here is unexpected (the
      // service already catches planning/engine errors internally and
      // returns them as a normal response) — reuse the same structured
      // error shape rather than a generic 500 with no code.
      return apiError(err.code, err.message, 400);
    }
    return apiError("EXECUTION_FAILED", "Unable to execute workflow. Please try again.", 500);
  }
}
