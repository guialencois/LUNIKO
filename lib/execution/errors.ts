import type { ExecutionError } from "./types";

export const ExecutionErrorCode = {
  WORKFLOW_INVALID: "WORKFLOW_INVALID",
  WORKFLOW_CONTAINS_CYCLE: "WORKFLOW_CONTAINS_CYCLE",
  WORKFLOW_REQUIRES_SINGLE_MANUAL_TRIGGER: "WORKFLOW_REQUIRES_SINGLE_MANUAL_TRIGGER",
  NODE_EXECUTOR_NOT_FOUND: "NODE_EXECUTOR_NOT_FOUND",
  NODE_EXECUTION_FAILED: "NODE_EXECUTION_FAILED",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  EXECUTION_CANCELLED: "EXECUTION_CANCELLED",
  EXECUTION_TIMEOUT: "EXECUTION_TIMEOUT",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  FORBIDDEN: "FORBIDDEN",
  WORKFLOW_NOT_FOUND: "WORKFLOW_NOT_FOUND",
  /** Fase 10.5A: an archived workflow receives no new executions. */
  WORKFLOW_ARCHIVED: "WORKFLOW_ARCHIVED",
  // Used by the recovery reaper (4F) when it gives up reclaiming a stale
  // "running" execution after claimAttempts hit the cap — named in
  // docs/async-execution.md since the 4C checkpoint, added here now that
  // something actually emits it.
  WORKER_CRASHED: "WORKER_CRASHED",
  // Fase 10 — external effects. Each names a distinct situation an executor
  // must surface as-is; none of them may be collapsed into another.
  /** The executor needs `context.effects` and it is absent (sync path). */
  EXTERNAL_EFFECTS_UNAVAILABLE: "EXTERNAL_EFFECTS_UNAVAILABLE",
  /** No businessKey: the operation cannot be identified safely. */
  BUSINESS_KEY_REQUIRED: "BUSINESS_KEY_REQUIRED",
  /** The provider definitively rejected the request. Nothing happened. */
  EXTERNAL_EFFECT_FAILED: "EXTERNAL_EFFECT_FAILED",
  /** It may or may not have happened. Needs explicit resolution. */
  EXTERNAL_EFFECT_UNKNOWN: "EXTERNAL_EFFECT_UNKNOWN",
  /** Same identity, different request — refused before sending. */
  EXTERNAL_EFFECT_PAYLOAD_MISMATCH: "EXTERNAL_EFFECT_PAYLOAD_MISMATCH",
  /** This attempt lost ownership of the execution. Nothing was sent. */
  EXTERNAL_EFFECT_FENCED: "EXTERNAL_EFFECT_FENCED",
  /** The operation's state could not be settled. Nothing was sent. */
  EXTERNAL_EFFECT_NOT_ATTEMPTED: "EXTERNAL_EFFECT_NOT_ATTEMPTED",
} as const;

export class ExecutionEngineError extends Error {
  code: string;
  nodeId?: string;
  nodeType?: string;
  retryable: boolean;

  constructor(
    code: string,
    message: string,
    opts?: { nodeId?: string; nodeType?: string; retryable?: boolean }
  ) {
    super(message);
    this.name = "ExecutionEngineError";
    this.code = code;
    this.nodeId = opts?.nodeId;
    this.nodeType = opts?.nodeType;
    this.retryable = opts?.retryable ?? false;
  }

  toExecutionError(): ExecutionError {
    return {
      code: this.code,
      message: this.message,
      nodeId: this.nodeId,
      nodeType: this.nodeType,
      retryable: this.retryable,
    };
  }
}
