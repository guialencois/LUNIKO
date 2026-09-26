import type { NodeExecutionContext, NodeExecutionResult, ExecutionLogger } from "./types";

/** Shared by executor unit tests — not a test file itself (doesn't match
 *  vitest's *.test.ts pattern), just a factory to avoid repeating this
 *  boilerplate in every executor test. */
export const noopLogger: ExecutionLogger = {
  info() {},
  warn() {},
  error() {},
};

export function makeContext(
  overrides: Partial<NodeExecutionContext> & { nodeType: string }
): NodeExecutionContext {
  return {
    executionId: "exec-test",
    workflowId: "wf-test",
    workspaceId: "ws-test",
    nodeId: "node-test",
    config: {},
    input: { items: [{ json: {} }] },
    inputsByHandle: {},
    previousResults: new Map<string, NodeExecutionResult>(),
    variables: {},
    logger: noopLogger,
    ...overrides,
  };
}
