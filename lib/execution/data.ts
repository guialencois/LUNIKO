import { ExecutionEngineError, ExecutionErrorCode } from "./errors";
import { EXECUTION_LIMITS, type NodeOutput } from "./types";

export function defaultInitialInput(): { items: { json: Record<string, unknown> }[] } {
  return { items: [{ json: {} }] };
}

/** Enforces item-count and output-size limits (item 30) before returning
 *  an output from an executor — a malformed or malicious workflow can't
 *  grow memory unboundedly through this engine. */
export function assertOutputWithinLimits(output: NodeOutput, nodeId: string): void {
  if (output.items.length > EXECUTION_LIMITS.MAX_ITEMS_PER_NODE) {
    throw new ExecutionEngineError(
      ExecutionErrorCode.LIMIT_EXCEEDED,
      `Node produced ${output.items.length} items, exceeding the limit of ${EXECUTION_LIMITS.MAX_ITEMS_PER_NODE}`,
      { nodeId }
    );
  }

  const size = JSON.stringify(output).length;
  if (size > EXECUTION_LIMITS.MAX_OUTPUT_SIZE_BYTES) {
    throw new ExecutionEngineError(
      ExecutionErrorCode.LIMIT_EXCEEDED,
      `Node output is ${size} bytes, exceeding the limit of ${EXECUTION_LIMITS.MAX_OUTPUT_SIZE_BYTES}`,
      { nodeId }
    );
  }
}

/** Times an executor call and normalizes a thrown error into the
 *  {status:"error", error, durationMs} shape — executors themselves don't
 *  need to repeat this boilerplate. */
export async function timed<T extends { status: string }>(
  fn: () => Promise<Omit<T, "durationMs">>
): Promise<T & { durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - start);
  return { ...result, durationMs } as T & { durationMs: number };
}
