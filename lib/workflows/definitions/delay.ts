import { z } from "zod";
import { registerNode } from "../registry";

export const delayConfigSchema = z.object({
  duration: z.number().positive().default(1),
  unit: z.enum(["seconds", "minutes", "hours"]).default("seconds"),
});

registerNode({
  type: "delay",
  displayName: "Delay",
  description: "Aguarda antes de continuar (execução real na Fase 3)",
  category: "utilities",
  icon: "Timer",
  color: "#a855f7",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: delayConfigSchema,
  defaultData: { duration: 1, unit: "seconds" },
});
