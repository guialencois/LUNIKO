import { z } from "zod";
import { registerNode } from "../registry";

// Fixed set of case slots (same pattern n8n itself uses — a bounded number
// of output ports, not one dynamically created per rule). This is what
// lets a rule's outputKey be validated as a real registry handle
// (lib/workflows/schema.ts's handle validation) without needing per-
// instance dynamic ports, which the Node Registry doesn't support and
// this phase's instructions said not to introduce.
export const SWITCH_CASE_HANDLES = ["case1", "case2", "case3"] as const;

export const switchRuleSchema = z.object({
  outputKey: z.enum(SWITCH_CASE_HANDLES),
  field: z.string().default(""),
  operator: z.enum(["equals", "notEquals", "contains"]).default("equals"),
  value: z.unknown().optional(),
});

export const switchConfigSchema = z.object({
  rules: z.array(switchRuleSchema).default([]),
});

registerNode({
  type: "switch",
  displayName: "Switch",
  description: "Ramifica o fluxo em até 3 casos, com fallback default",
  category: "logic",
  icon: "Split",
  color: "#f59e0b",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [
    { id: "case1", label: "Case 1" },
    { id: "case2", label: "Case 2" },
    { id: "case3", label: "Case 3" },
    { id: "default", label: "Default" },
  ],
  configSchema: switchConfigSchema,
  defaultData: { rules: [] },
});
