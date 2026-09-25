import type { NodeExecutor } from "../types";

/**
 * Deliberately a second registry, not a merge into lib/workflows/registry.ts
 * — that registry describes nodes (for the editor), this one executes them.
 * Both are keyed by the same `type` string, which is the only shared
 * identity between a NodeDefinition and its NodeExecutor (item 7).
 */
const executors = new Map<string, NodeExecutor>();

export function registerExecutor(executor: NodeExecutor): void {
  if (executors.has(executor.nodeType)) {
    throw new Error(`Executor for node type "${executor.nodeType}" is already registered`);
  }
  executors.set(executor.nodeType, executor);
}

export function getExecutor(nodeType: string): NodeExecutor | undefined {
  return executors.get(nodeType);
}

export function hasExecutor(nodeType: string): boolean {
  return executors.has(nodeType);
}
