import { z } from "zod";
import { registerNode } from "../registry";

export const transformConfigSchema = z.object({
  mode: z.enum(["map", "filter", "reduce"]).default("map"),
});

registerNode({
  type: "transform",
  displayName: "Transform",
  description: "Transforma objetos/arrays (execução real na Fase 3)",
  category: "data",
  icon: "Wand2",
  color: "#22c55e",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: transformConfigSchema,
  defaultData: { mode: "map" },
});
