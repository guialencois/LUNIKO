import { registerExecutor } from "./registry";
import { ExecutionErrorCode } from "../errors";
import type { NodeExecutor } from "../types";

/**
 * Deliberately NOT_IMPLEMENTED (item 15 do prompt mestre). A real
 * implementation needs, before it can run unattended workflow code against
 * arbitrary URLs: HTTPS-only enforcement, an allowed-methods list, a
 * request timeout, a max response size, controlled redirect handling, and
 * — the hard part — blocking requests to private IP ranges, localhost, and
 * cloud metadata endpoints (SSRF protection) at the network level, not just
 * a URL string check (DNS rebinding defeats naive URL checks). None of that
 * exists yet. Rather than ship a version that "works" but is trivially
 * abusable as an SSRF vector, this executor refuses clearly. See
 * docs/node-executors.md for the intended policy when this is built.
 */
const httpRequestExecutor: NodeExecutor = {
  nodeType: "httpRequest",
  async execute(context) {
    const start = performance.now();
    return {
      status: "error" as const,
      durationMs: Math.round(performance.now() - start),
      error: {
        code: ExecutionErrorCode.NOT_IMPLEMENTED,
        message:
          "HTTP Request execution is not available in this execution environment yet — it requires an SSRF-safe HTTP policy that hasn't been built (see docs/node-executors.md).",
        nodeId: context.nodeId,
        nodeType: "httpRequest",
        retryable: false,
      },
    };
  },
};

registerExecutor(httpRequestExecutor);
