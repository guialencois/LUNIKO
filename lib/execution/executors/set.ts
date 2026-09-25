import { registerExecutor } from "./registry";
import { assertOutputWithinLimits } from "../data";
import type { NodeExecutor } from "../types";

const setExecutor: NodeExecutor = {
  nodeType: "set",
  async execute(context) {
    const start = performance.now();
    const values = (context.config.values as Record<string, unknown>) ?? {};

    const output = {
      items: context.input.items.map((item) => ({
        json: { ...item.json, ...values },
      })),
    };

    assertOutputWithinLimits(output, context.nodeId);

    return {
      status: "success" as const,
      output,
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(setExecutor);
