import { ExecutionEngineError, ExecutionErrorCode } from "@/lib/execution/errors";
import { pgErrorCode } from "@/lib/db/errors";

/**
 * Fase 10.5A: an archived workflow receives no new executions — on either
 * path (sync or queued). The services check `archivedAt` right after
 * loading the workflow, which answers the common case with a clear error;
 * the database (trigger executions_refuse_archived_workflow, 0007) refuses
 * the insert itself, which covers the race where someone archives between
 * that check and the insert. Both end as the same error.
 */
export function workflowArchivedError(): ExecutionEngineError {
  return new ExecutionEngineError(
    ExecutionErrorCode.WORKFLOW_ARCHIVED,
    "This workflow is archived. Restore it before executing it."
  );
}

/** Runs the insert of a new execution, translating the database's refusal
 *  (SQLSTATE WK001) into workflowArchivedError(). */
export async function refusingArchived<T>(insert: () => Promise<T>): Promise<T> {
  try {
    return await insert();
  } catch (err) {
    if (pgErrorCode(err) === "WK001") throw workflowArchivedError();
    throw err;
  }
}
