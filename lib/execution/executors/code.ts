import { registerExecutor } from "./registry";
import { ExecutionErrorCode } from "../errors";
import type { NodeExecutor } from "../types";

/**
 * NEVER implement this with eval(), new Function(), or vm.runInThisContext()
 * — item 16 do prompt mestre is explicit, and this stays true regardless of
 * how this executor evolves. Safe arbitrary-code execution needs a real
 * sandbox (isolated process/worker, resource limits, no ambient access to
 * the app's own environment/secrets) that doesn't exist yet.
 */
const codeExecutor: NodeExecutor = {
  nodeType: "code",
  async execute(context) {
    const start = performance.now();
    return {
      status: "error" as const,
      durationMs: Math.round(performance.now() - start),
      error: {
        code: ExecutionErrorCode.NOT_IMPLEMENTED,
        message: "Code node execution is not available in this execution environment.",
        nodeId: context.nodeId,
        nodeType: "code",
        retryable: false,
      },
    };
  },
};

registerExecutor(codeExecutor);
