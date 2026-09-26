import { getWorkflowById } from "@/server/workflows/queries";
import { createExecution, finishExecution, insertExecutionNodes } from "./execution-repository";
import { buildExecutionPlan } from "@/lib/execution/planner";
import { runExecutionPlan } from "@/lib/execution/executor";
import { ExecutionEngineError, ExecutionErrorCode } from "@/lib/execution/errors";
import { buildExecutionApiResponse, type ExecutionApiResponse } from "@/lib/execution/result";
import { refusingArchived, workflowArchivedError } from "./workflow-archived";
import type { ExecutionLogger, NodeInput } from "@/lib/execution/types";

export interface ExecuteWorkflowInput {
  userId: string;
  workspaceId: string;
  workflowId: string;
  input?: NodeInput;
}

/** Minimal structured console logger (item 28). Not persisted/queryable
 *  yet — that's future work; what matters now is it never logs anything
 *  from a node's config/output verbatim without going through the same
 *  redaction the repository applies to what's actually stored. */
function createExecutionLogger(executionId: string): ExecutionLogger {
  const base = (level: string, message: string, meta?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
      JSON.stringify({ level, executionId, message, ...meta })
    );
  };
  return {
    info: (message, meta) => base("info", message, meta),
    warn: (message, meta) => base("warn", message, meta),
    error: (message, meta) => base("error", message, meta),
  };
}

/**
 * The one entry point for running a workflow (item 25). Enforces the full
 * chain end to end:
 *
 *   authenticate (caller's job, before calling this)
 *     -> workspace membership (via getWorkflowById / requireWorkspaceMembership)
 *     -> workflow belongs to that workspace (getWorkflowById's own WHERE clause)
 *     -> document snapshot taken at execution time
 *     -> plan -> engine
 *     -> persisted execution + execution_nodes, scoped to the same workspace
 *
 * Never trusts workspaceId from the caller alone — every persistence call
 * re-checks requireWorkspaceMembership independently (see
 * execution-repository.ts), so there is no path that reaches the database
 * on the strength of an executionId or workflowId by itself.
 */
export async function executeWorkflow(
  input: ExecuteWorkflowInput
): Promise<ExecutionApiResponse> {
  const workflow = await getWorkflowById(input.userId, input.workspaceId, input.workflowId);
  if (!workflow) {
    throw new ExecutionEngineError(
      ExecutionErrorCode.WORKFLOW_NOT_FOUND,
      "This workflow could not be found"
    );
  }
  // Fase 10.5A: see workflow-archived.ts.
  if (workflow.archivedAt) throw workflowArchivedError();

  // Snapshot taken now, before planning/execution — this is what
  // executions.document ends up holding, so even if the workflow is
  // edited later, this execution keeps a clear reference to what actually
  // ran (item 8 / item 37).
  const documentSnapshot = workflow.document;

  const executionRow = await refusingArchived(() =>
    createExecution(input.userId, input.workspaceId, input.workflowId, documentSnapshot)
  );

  const logger = createExecutionLogger(executionRow.id);
  const startedAt = Date.now();

  try {
    const plan = buildExecutionPlan(input.workflowId, documentSnapshot);

    const outcome = await runExecutionPlan(plan, {
      executionId: executionRow.id,
      workflowId: input.workflowId,
      workspaceId: input.workspaceId,
      initialInput: input.input ?? { items: [{ json: {} }] },
      logger,
    });

    await insertExecutionNodes(
      input.userId,
      input.workspaceId,
      executionRow.id,
      outcome.nodeResults
    );

    await finishExecution(input.userId, input.workspaceId, executionRow.id, {
      status: outcome.status,
      durationMs: Date.now() - startedAt,
      error: outcome.error,
    });

    return buildExecutionApiResponse(executionRow.id, outcome);
  } catch (err) {
    // Planning failures (invalid document, cycle, etc.) never reach
    // runExecutionPlan — still record them against the execution row that
    // was already created, so there's always an audit trail, not just a
    // thrown error the caller has to translate into a record itself.
    const executionError =
      err instanceof ExecutionEngineError
        ? err.toExecutionError()
        : {
            code: ExecutionErrorCode.WORKFLOW_INVALID,
            message: err instanceof Error ? err.message : "Unknown execution error",
          };

    await finishExecution(input.userId, input.workspaceId, executionRow.id, {
      status: "error",
      durationMs: Date.now() - startedAt,
      error: executionError,
    });

    return {
      executionId: executionRow.id,
      status: "error",
      error: {
        code: executionError.code,
        message: executionError.message,
        nodeId: executionError.nodeId,
      },
    };
  }
}
