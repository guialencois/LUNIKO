import { getWorkflowById } from "@/server/workflows/queries";
import { buildExecutionPlan } from "@/lib/execution/planner";
import { ExecutionEngineError, ExecutionErrorCode } from "@/lib/execution/errors";
import { createQueuedExecution } from "./execution-repository";
import { enqueueExecution } from "./execution-queue";
import { refusingArchived, workflowArchivedError } from "./workflow-archived";

/**
 * The PRODUCER of the asynchronous path — the piece that was missing
 * between the product and the lifecycle built in 4C–4G. Until now
 * createQueuedExecution had no call site outside tests: the queue, the
 * claim, the worker processor, the fencing and the reaper all existed and
 * were validated, but nothing in the application ever put a job in.
 *
 * This is deliberately the mirror of executeWorkflow() up to the moment
 * where that function starts the engine — and it stops exactly there. It
 * never plans-and-runs, never touches an executor, never writes a result.
 * Its whole job is: authorize, validate, snapshot, enqueue.
 *
 *   auth (caller's job)
 *     -> workspace membership        (getWorkflowById -> requireWorkspaceMembership)
 *     -> workflow belongs to it      (getWorkflowById's own WHERE clause)
 *     -> document is executable      (buildExecutionPlan, validation only)
 *     -> snapshot + "queued" row     (createQueuedExecution, runner "worker")
 *     -> job is queueable            (enqueueExecution)
 *     -> { executionId, status: "queued" }
 *
 * WHY IT VALIDATES BEFORE QUEUEING
 * buildExecutionPlan is the same validator the synchronous path and the
 * worker already use — not a second one. Running it here means an
 * unexecutable workflow is refused at the API boundary, with a real error
 * the caller can act on, instead of becoming a queued job whose only
 * possible outcome is a failure the caller discovers much later. The
 * worker still validates independently when it claims the job; this is a
 * fast rejection, not a replacement for that.
 *
 * WHAT IT DOES NOT PUT IN THE QUEUE
 * Only the executionId travels (docs/async-execution.md, "Fila — decisão
 * conceitual"). No document, no workspaceId, no userId, no credentials.
 * The persisted snapshot on the execution row is the source of truth for
 * whatever eventually runs it.
 */

export interface EnqueueWorkflowExecutionInput {
  userId: string;
  workspaceId: string;
  workflowId: string;
}

export interface EnqueuedExecutionResponse {
  executionId: string;
  status: "queued";
}

export async function enqueueWorkflowExecution(
  input: EnqueueWorkflowExecutionInput
): Promise<EnqueuedExecutionResponse> {
  const workflow = await getWorkflowById(input.userId, input.workspaceId, input.workflowId);
  if (!workflow) {
    // Same shape the synchronous path throws, so the route translates both
    // into the same 404 without knowing which path produced it. A workflow
    // in another workspace is "not found", never "forbidden".
    throw new ExecutionEngineError(
      ExecutionErrorCode.WORKFLOW_NOT_FOUND,
      "This workflow could not be found"
    );
  }
  // Fase 10.5A: see workflow-archived.ts.
  if (workflow.archivedAt) throw workflowArchivedError();

  // Snapshot taken now, before anything is queued: this is what
  // executions.document holds and what the worker will execute, so a later
  // edit to the workflow cannot change what this run does. Stored intact —
  // see the redaction note in execution-repository.ts.
  const documentSnapshot = workflow.document;

  // Validation only. buildExecutionPlan throws ExecutionEngineError for an
  // invalid document, a cycle, or a missing/duplicated manual trigger; the
  // plan it returns is intentionally discarded, because planning here and
  // executing later would mean the run depended on a plan built by a
  // different process at a different time.
  buildExecutionPlan(input.workflowId, documentSnapshot);

  const execution = await refusingArchived(() =>
    createQueuedExecution(input.userId, input.workspaceId, input.workflowId, documentSnapshot)
  );

  // Confirms the row is in a queueable state and yields the minimal job
  // descriptor. There is no dispatch call here because there is no separate
  // queue to dispatch to: the executions table IS the queue, so the row
  // created above already is the job. This is the seam a real dispatch
  // would attach to if the architecture ever grows one.
  await enqueueExecution(execution.id);

  return { executionId: execution.id, status: "queued" };
}
