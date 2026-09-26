import { registerExecutor } from "./registry";
import { assertOutputWithinLimits } from "../data";
import { ExecutionErrorCode } from "../errors";
import type { NodeExecutor } from "../types";

const mergeExecutor: NodeExecutor = {
  nodeType: "merge",
  /**
   * SEMANTICS (decided explicitly, not incidental): merge runs as soon as
   * at least one of its input ports has an active incoming edge — it does
   * NOT wait for every port. A branch that was deliberately skipped
   * (e.g. the untaken side of an upstream IF) must never block merge from
   * running; it simply isn't part of what gets aggregated. If neither
   * input1 nor input2 is active, the engine already skips this node
   * entirely before execute() is ever called (lib/execution/executor.ts:
   * activeEdges.length === 0 -> continue) — so by the time we're here, we
   * know at least one of the two is present, and we just aggregate
   * whichever one(s) are. inputsByHandle keeps input1/input2 separate so
   * this stays possible even if a future merge mode needs to treat them
   * differently.
   */
  async execute(context) {
    const start = performance.now();
    const mode = (context.config.mode as string) ?? "append";

    if (mode !== "append") {
      return {
        status: "error" as const,
        durationMs: Math.round(performance.now() - start),
        error: {
          code: ExecutionErrorCode.NOT_IMPLEMENTED,
          message: `Merge mode "${mode}" is not implemented. Only "append" is supported in this phase.`,
          nodeId: context.nodeId,
          nodeType: "merge",
          retryable: false,
        },
      };
    }

    // "append": concatenate items from every input port that actually has
    // data, in a deterministic order (input1 before input2).
    const input1 = context.inputsByHandle.input1?.items ?? [];
    const input2 = context.inputsByHandle.input2?.items ?? [];
    const output = { items: [...input1, ...input2] };

    assertOutputWithinLimits(output, context.nodeId);

    return {
      status: "success" as const,
      output,
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(mergeExecutor);
