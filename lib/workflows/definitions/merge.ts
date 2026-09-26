import { z } from "zod";
import { registerNode } from "../registry";

export const mergeConfigSchema = z.object({
  mode: z.enum(["append", "combine"]).default("append"),
});

registerNode({
  type: "merge",
  displayName: "Merge",
  description: "Combina dados de branches",
  category: "logic",
  icon: "Merge",
  color: "#f59e0b",
  inputs: [
    { id: "input1", label: "Input 1" },
    { id: "input2", label: "Input 2" },
  ],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: mergeConfigSchema,
  defaultData: { mode: "append" },
});
