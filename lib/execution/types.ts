import type { EffectRunner } from "./effects";

/**
 * Execution-domain types. Nothing here imports from components/workflow/*
 * or the Zustand editor store — the engine must be runnable from a Route
 * Handler with no React in the picture at all (item 6/36 do prompt mestre).
 */

// ---- Data model (item 9) ----------------------------------------------

export interface ExecutionItem {
  json: Record<string, unknown>;
}

export interface NodeInput {
  items: ExecutionItem[];
}

export interface NodeOutput {
  items: ExecutionItem[];
}

// ---- Errors (item 21) ---------------------------------------------------

export interface ExecutionError {
  code: string;
  message: string;
  nodeId?: string;
  nodeType?: string;
  retryable?: boolean;
}

// ---- Execution (item 4) --------------------------------------------------

export type ExecutionStatus = "queued" | "running" | "success" | "error" | "cancelled";

export interface Execution {
  id: string;
  workflowId: string;
  workspaceId: string;
  status: ExecutionStatus;
  /** Snapshot of the WorkflowDocument actually executed (item 37 — Fase 2
   *  has no workflow_versions table yet, so this snapshot is the minimal
   *  "clear reference to the executed document" the spec asks for). */
  document: unknown;
  startedAt?: string;
  finishedAt?: string;
  error?: ExecutionError;
}

// ---- Node execution (items 5, 6, 8) --------------------------------------

export interface ExecutionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface NodeExecutionContext {
  executionId: string;
  workflowId: string;
  workspaceId: string;

  nodeId: string;
  nodeType: string;
  /** Already validated against the node's own configSchema by the planner. */
  config: Record<string, unknown>;

  /** Aggregated input: every item from every resolved incoming edge. Most
   *  nodes (single input port) only ever need this. */
  input: NodeInput;

  /** Same data, but split by target handle id — for nodes with more than
   *  one input port (e.g. "merge", which has input1/input2). Nodes with a
   *  single input port can ignore this and just use `input`. */
  inputsByHandle: Record<string, NodeInput>;

  previousResults: ReadonlyMap<string, NodeExecutionResult>;

  variables: Record<string, unknown>;

  signal?: AbortSignal;

  logger: ExecutionLogger;

  /**
   * Fase 10: the claim epoch this node runs under. Present only on the
   * worker path. It identifies the ATTEMPT, never the operation — an
   * executor must not put it into anything meant to stay the same across
   * attempts, such as an idempotency key.
   */
  epoch?: number;

  /**
   * Fase 10: the ONLY sanctioned way for an executor to cause an effect
   * outside this system. Injected by the worker, bound to this execution
   * and this epoch. Absent on the synchronous path, which has no recovery
   * and therefore no way to settle an ambiguous outcome — an executor that
   * needs it must fail clearly when it is missing, never call out directly.
   */
  effects?: EffectRunner;
}

export interface NodeExecutionResult {
  status: "success" | "error";
  output?: NodeOutput;
  /** For branching nodes (if/switch): which of their output handles are
   *  "taken". Downstream nodes connected only via a handle not listed here
   *  are not executed (item 18/19). Absent/undefined means "all outputs
   *  taken" (the normal case for non-branching nodes). */
  nextHandles?: string[];
  durationMs: number;
  error?: ExecutionError;
}

export interface NodeExecutor {
  nodeType: string;
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

// ---- Planner (items 10, 11) -----------------------------------------------

export interface PlannedNode {
  nodeId: string;
  nodeType: string;
  config: Record<string, unknown>;
}

export interface PlannedEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

export interface ExecutionPlan {
  workflowId: string;
  nodes: PlannedNode[];
  edges: PlannedEdge[];
  /** Nodes with no incoming edge at all (graph-theoretic sense — not
   *  necessarily the node manual execution actually starts from). */
  entryNodes: string[];
  /** Topological order of all node ids. Execution walks this order,
   *  skipping nodes that turn out not to be reachable from the trigger
   *  once branch decisions are known (see lib/execution/executor.ts). */
  topologicalOrder: string[];
  /** The single manualTrigger node this plan starts from. */
  manualTriggerNodeId: string;
}

// ---- Limits (item 30) -----------------------------------------------------

export const EXECUTION_LIMITS = {
  MAX_NODES_PER_EXECUTION: 500,
  MAX_EXECUTION_TIME_MS: 30_000,
  MAX_ITEMS_PER_NODE: 1000,
  /** Bytes, measured as JSON.stringify(...).length of a node's output. */
  MAX_OUTPUT_SIZE_BYTES: 5 * 1024 * 1024,
  /** Delay node cap — see docs/node-executors.md for why this isn't the
   *  user-configured duration. */
  MAX_DELAY_MS: 2000,
} as const;
