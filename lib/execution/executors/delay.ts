import { registerExecutor } from "./registry";
import { EXECUTION_LIMITS } from "../types";
import type { NodeExecutor } from "../types";

function toMs(duration: number, unit: string): number {
  switch (unit) {
    case "minutes":
      return duration * 60_000;
    case "hours":
      return duration * 3_600_000;
    case "seconds":
    default:
      return duration * 1_000;
  }
}

/**
 * Real delay, but capped at EXECUTION_LIMITS.MAX_DELAY_MS (item 14: "evitar
 * prender o processo com setTimeout longo... pode haver uma implementação
 * de teste curta"). A workflow configured for a 1-hour delay will actually
 * wait 2 seconds here and say so in the log — this engine is synchronous
 * and has no queue to come back to later yet (that's a future phase).
 */
const delayExecutor: NodeExecutor = {
  nodeType: "delay",
  async execute(context) {
    const start = performance.now();
    const duration = (context.config.duration as number) ?? 1;
    const unit = (context.config.unit as string) ?? "seconds";
    const requestedMs = toMs(duration, unit);
    const actualMs = Math.min(requestedMs, EXECUTION_LIMITS.MAX_DELAY_MS);

    if (actualMs < requestedMs) {
      context.logger.warn(
        `delay: capped ${requestedMs}ms request to ${actualMs}ms — this engine is synchronous and has no queue to resume from later yet`,
        { nodeId: context.nodeId }
      );
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, actualMs);
      context.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    return {
      status: "success" as const,
      output: context.input,
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(delayExecutor);
