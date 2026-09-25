/**
 * A workflow request that is valid but conflicts with the workflow's state.
 * Routes answer 409 with `code` — each one names a different situation the
 * caller can act on, so none is collapsed into another.
 *
 *   WORKFLOW_ARCHIVED               archived workflows are read-only and
 *                                   receive no executions — restore first
 *   WORKFLOW_HAS_EFFECT_HISTORY     it caused external effects; their record
 *                                   is evidence and is never deleted in
 *                                   cascade — archive instead
 *   WORKFLOW_HAS_ACTIVE_EXECUTIONS  queued/running worker executions exist —
 *                                   wait for them before archiving
 */
export type WorkflowConflictCode =
  | "WORKFLOW_ARCHIVED"
  | "WORKFLOW_HAS_EFFECT_HISTORY"
  | "WORKFLOW_HAS_ACTIVE_EXECUTIONS";

export class WorkflowConflictError extends Error {
  code: WorkflowConflictCode;
  constructor(code: WorkflowConflictCode, message: string) {
    super(message);
    this.name = "WorkflowConflictError";
    this.code = code;
  }
}

export const WORKFLOW_CONFLICT_MESSAGES: Record<WorkflowConflictCode, string> = {
  WORKFLOW_ARCHIVED: "This workflow is archived. Restore it before editing or executing it.",
  WORKFLOW_HAS_EFFECT_HISTORY:
    "This workflow has caused external effects (messages, charges), and that history is kept as evidence. Archive it instead of deleting it.",
  WORKFLOW_HAS_ACTIVE_EXECUTIONS:
    "This workflow has queued or running executions. Wait for them to finish before archiving it.",
};
