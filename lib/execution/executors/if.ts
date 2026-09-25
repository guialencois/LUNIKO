import { registerExecutor } from "./registry";
import type { NodeExecutor } from "../types";

interface Condition {
  field: string;
  operator: "equals" | "notEquals" | "greaterThan" | "lessThan" | "contains";
  value?: unknown;
}

/**
 * Safe, hand-written comparison — no eval/new Function/expression language.
 * Deliberately simple: top-level field lookup only (matches the `field:
 * string` shape of ifConfigSchema — no nested-path parser exists yet).
 */
function evaluateCondition(json: Record<string, unknown>, condition: Condition): boolean {
  const actual = json[condition.field];
  switch (condition.operator) {
    case "equals":
      return actual === condition.value;
    case "notEquals":
      return actual !== condition.value;
    case "greaterThan":
      return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
    case "lessThan":
      return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
    case "contains":
      if (typeof actual === "string" && typeof condition.value === "string") {
        return actual.includes(condition.value);
      }
      if (Array.isArray(actual)) {
        return actual.includes(condition.value);
      }
      return false;
    default:
      return false;
  }
}

const ifExecutor: NodeExecutor = {
  nodeType: "if",
  async execute(context) {
    const start = performance.now();
    const conditions = (context.config.conditions as Condition[]) ?? [];

    // Simplification, documented in docs/node-executors.md: evaluated once
    // against the first item, not per-item. Per-item branching would need
    // the engine to split a single item stream across handles, which is
    // out of scope for this first version of the engine.
    const firstItemJson = context.input.items[0]?.json ?? {};
    const passed =
      conditions.length === 0 || conditions.every((c) => evaluateCondition(firstItemJson, c));

    const selectedHandle = passed ? "true" : "false";

    return {
      status: "success" as const,
      output: context.input,
      nextHandles: [selectedHandle],
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(ifExecutor);
