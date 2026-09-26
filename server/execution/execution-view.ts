import type { ExecutionRow, ExecutionNodeRow } from "@/lib/db/schema";
import type { ExecutionStatus } from "@/lib/execution/types";

/**
 * The public shape of an execution, for GET /api/executions/[executionId].
 *
 * THIS IS AN ALLOWLIST, AND THAT IS THE POINT. Every field is named
 * explicitly and the row is never spread. A spread would mean that any
 * column added to `executions` later — a credential reference, a heartbeat,
 * an internal flag — starts leaking to the browser the moment the migration
 * lands, silently, with no code change to notice in review. Adding a field
 * here has to be a decision someone makes on purpose.
 *
 * WHAT IS KEPT OUT, AND WHY
 *
 *   runner          internal lifecycle ownership ("request" vs "worker").
 *                   Nothing a user can act on; it describes how the system
 *                   is built, not what happened to their execution.
 *
 *   claimAttempts   the fencing epoch. Exposing it would hand a client the
 *                   value that decides who may write an execution's final
 *                   state — material for reasoning about the lock, with no
 *                   benefit whatsoever to the UI.
 *
 *   document        the workflow snapshot. Not a leak in itself (the read
 *                   path already redacts credential-bearing HTTP headers,
 *                   see lib/workflows/redaction.ts), but it is large, and
 *                   this endpoint is designed to be polled. The UI already
 *                   has the workflow it is looking at.
 *
 *   workspaceId,    authorization inputs and audit metadata. The caller had
 *   createdBy       to be a member of the workspace to reach this at all;
 *                   echoing the ids back adds nothing.
 *
 *   node input      per-node payloads, same size reasoning as `document`.
 *   and output      The final `result` is what a caller polls for; a
 *                   per-node inspector is its own endpoint when it exists.
 */

export interface ExecutionErrorView {
  code: string;
  message: string;
  nodeId?: string;
}

export interface ExecutionNodeView {
  nodeId: string;
  nodeType: string;
  status: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: ExecutionErrorView;
}

export interface ExecutionDetailView {
  executionId: string;
  workflowId: string;
  status: ExecutionStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  result?: unknown;
  error?: ExecutionErrorView;
  nodes: ExecutionNodeView[];
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toErrorView(value: unknown): ExecutionErrorView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    code: typeof raw.code === "string" ? raw.code : "UNKNOWN_ERROR",
    message: typeof raw.message === "string" ? raw.message : "Execution failed with no error detail",
    ...(typeof raw.nodeId === "string" ? { nodeId: raw.nodeId } : {}),
  };
}

export function toExecutionDetailView(
  execution: ExecutionRow,
  nodes: ExecutionNodeRow[]
): ExecutionDetailView {
  const view: ExecutionDetailView = {
    executionId: execution.id,
    workflowId: execution.workflowId,
    status: execution.status,
    createdAt: execution.createdAt.toISOString(),
    // Non-terminal executions legitimately have nulls here: a "queued" row
    // has not started, and a "running" one has not finished. The contract
    // says "timestamps available", not "timestamps invented".
    startedAt: iso(execution.startedAt),
    finishedAt: iso(execution.finishedAt),
    durationMs: execution.durationMs,
    nodes: nodes.map((node) => ({
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      status: node.status,
      durationMs: node.durationMs,
      startedAt: node.startedAt.toISOString(),
      finishedAt: node.finishedAt.toISOString(),
      ...(toErrorView(node.error) ? { error: toErrorView(node.error)! } : {}),
    })),
  };

  // `result` only exists for a run that succeeded; `error` only for one
  // that failed or was cancelled. Neither is fabricated for a run still in
  // flight.
  if (execution.status === "success" && execution.result !== null) {
    view.result = execution.result;
  }

  const error = toErrorView(execution.error);
  if (error && (execution.status === "error" || execution.status === "cancelled")) {
    view.error = error;
  }

  return view;
}
