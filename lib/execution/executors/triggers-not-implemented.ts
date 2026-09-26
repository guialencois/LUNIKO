import { registerExecutor } from "./registry";
import { ExecutionErrorCode } from "../errors";
import type { NodeExecutor } from "../types";

/**
 * webhookTrigger and scheduleTrigger are trigger definitions only in this
 * phase (item 17 do prompt mestre) — there is no real webhook endpoint and
 * no real scheduler. They're also not valid as the entry point for manual
 * execution (the planner requires exactly one manualTrigger — see
 * lib/execution/planner.ts), so this executor only exists in case one ends
 * up reachable mid-graph, which the planner doesn't otherwise forbid.
 */
function notImplementedTrigger(nodeType: string, displayName: string): NodeExecutor {
  return {
    nodeType,
    async execute(context) {
      const start = performance.now();
      return {
        status: "error" as const,
        durationMs: Math.round(performance.now() - start),
        error: {
          code: ExecutionErrorCode.NOT_IMPLEMENTED,
          message: `${displayName} does not trigger real execution in this phase — it is a definition only.`,
          nodeId: context.nodeId,
          nodeType,
          retryable: false,
        },
      };
    },
  };
}

registerExecutor(notImplementedTrigger("webhookTrigger", "Webhook Trigger"));
registerExecutor(notImplementedTrigger("scheduleTrigger", "Schedule Trigger"));
