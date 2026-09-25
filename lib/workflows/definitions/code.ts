import { z } from "zod";
import { registerNode } from "../registry";

export const codeConfigSchema = z.object({
  language: z.literal("javascript").default("javascript"),
  code: z.string().default(""),
});

registerNode({
  type: "code",
  displayName: "Code",
  description: "Código JavaScript (armazenado apenas — execução em sandbox na Fase 6+)",
  category: "code",
  icon: "Code2",
  color: "#64748b",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: codeConfigSchema,
  defaultData: { language: "javascript", code: "" },
});
