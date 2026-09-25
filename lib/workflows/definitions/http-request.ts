import { z } from "zod";
import { registerNode } from "../registry";

export const httpRequestConfigSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  url: z.string().default(""),
  headers: z.record(z.string()).default({}),
  query: z.record(z.string()).default({}),
  body: z.unknown().nullable().default(null),
});

registerNode({
  type: "httpRequest",
  displayName: "HTTP Request",
  description: "Executa uma requisição HTTP (execução real na Fase 3)",
  category: "action",
  icon: "Globe",
  color: "#0ea5e9",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: httpRequestConfigSchema,
  defaultData: { method: "GET", url: "", headers: {}, query: {}, body: null },
});
