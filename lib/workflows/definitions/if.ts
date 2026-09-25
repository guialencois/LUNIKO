import { z } from "zod";
import { registerNode } from "../registry";

export const conditionSchema = z.object({
  field: z.string().default(""),
  operator: z
    .enum(["equals", "notEquals", "greaterThan", "lessThan", "contains"])
    .default("equals"),
  value: z.unknown().optional(),
});

export const ifConfigSchema = z.object({
  conditions: z.array(conditionSchema).default([]),
});

registerNode({
  type: "if",
  displayName: "IF",
  description: "Ramifica o fluxo em verdadeiro/falso (avaliação real na Fase 3)",
  category: "logic",
  icon: "GitFork",
  color: "#f59e0b",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [
    { id: "true", label: "True" },
    { id: "false", label: "False" },
  ],
  configSchema: ifConfigSchema,
  defaultData: { conditions: [] },
});
