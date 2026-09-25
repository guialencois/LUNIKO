import { registerExecutor } from "./registry";
import { defaultInitialInput } from "../data";
import type { NodeExecutor } from "../types";

const manualTriggerExecutor: NodeExecutor = {
  nodeType: "manualTrigger",
  async execute(context) {
    const start = performance.now();
    // The engine seeds context.input with whatever the caller passed to
    // executeWorkflow(); if nothing was passed, fall back to one empty item
    // (item 13 do prompt mestre).
    const output =
      context.input.items.length > 0 ? context.input : defaultInitialInput();

    return {
      status: "success" as const,
      output,
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(manualTriggerExecutor);
