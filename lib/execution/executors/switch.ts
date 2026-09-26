import { registerExecutor } from "./registry";
import type { NodeExecutor } from "../types";

interface SwitchRule {
  outputKey: "case1" | "case2" | "case3";
  field: string;
  operator: "equals" | "notEquals" | "contains";
  value?: unknown;
}

function evaluateRule(json: Record<string, unknown>, rule: SwitchRule): boolean {
  const actual = json[rule.field];
  switch (rule.operator) {
    case "equals":
      return actual === rule.value;
    case "notEquals":
      return actual !== rule.value;
    case "contains":
      return typeof actual === "string" && typeof rule.value === "string" && actual.includes(rule.value);
    default:
      return false;
  }
}

/**
 * Real branching: rules are evaluated in order against the first item
 * (same simplification as `if` — single-item evaluation, documented in
 * docs/node-executors.md); the first matching rule's outputKey becomes the
 * one active handle. No match -> "default". Never routes to more than one
 * handle, and never fakes a match just to have something to route to.
 */
const switchExecutor: NodeExecutor = {
  nodeType: "switch",
  async execute(context) {
    const start = performance.now();
    const rules = (context.config.rules as SwitchRule[]) ?? [];
    const firstItemJson = context.input.items[0]?.json ?? {};
    const matchedRule = rules.find((rule) => evaluateRule(firstItemJson, rule));
    const selectedHandle = matchedRule?.outputKey ?? "default";

    context.logger.info(`switch: routing to "${selectedHandle}"`, {
      nodeId: context.nodeId,
      matched: Boolean(matchedRule),
    });

    return {
      status: "success" as const,
      output: context.input,
      nextHandles: [selectedHandle],
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(switchExecutor);
