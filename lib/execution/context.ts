import type { NodeInput, NodeExecutionResult, ExecutionLogger } from "./types";
import type { EffectRunner } from "./effects";

export interface BuildContextInput {
  executionId: string;
  workflowId: string;
  workspaceId: string;
  nodeId: string;
  nodeType: string;
  config: Record<string, unknown>;
  input: NodeInput;
  inputsByHandle: Record<string, NodeInput>;
  previousResults: ReadonlyMap<string, NodeExecutionResult>;
  variables: Record<string, unknown>;
  signal?: AbortSignal;
  logger: ExecutionLogger;
  epoch?: number;
  effects?: EffectRunner;
}

/** Thin factory so lib/execution/executor.ts doesn't build this object
 *  inline — keeps the shape in one place if fields are added later. */
export function buildNodeExecutionContext(input: BuildContextInput): BuildContextInput {
  return input;
}
