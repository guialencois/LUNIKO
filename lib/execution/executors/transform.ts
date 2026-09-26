import { registerExecutor } from "./registry";
import { assertOutputWithinLimits } from "../data";
import type { NodeExecutor } from "../types";

/**
 * Transform's configSchema (lib/workflows/definitions/transform.ts) only
 * has a `mode` field ("map"/"filter"/"reduce") — it has no field yet for
 * *what* mapping/filter/reduce to apply. There is nothing safe to execute
 * beyond passing items through unchanged, for any mode. This is not a
 * shortcut: defining a safe expression language for actual transformations
 * is future work (see docs/node-executors.md), and until it exists this
 * executor deliberately does nothing rather than pretend to.
 */
const transformExecutor: NodeExecutor = {
  nodeType: "transform",
  async execute(context) {
    const start = performance.now();
    const output = { items: context.input.items.map((item) => ({ json: { ...item.json } })) };
    assertOutputWithinLimits(output, context.nodeId);

    context.logger.info("transform: pass-through (no mapping expression support yet)", {
      nodeId: context.nodeId,
    });

    return {
      status: "success" as const,
      output,
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(transformExecutor);
