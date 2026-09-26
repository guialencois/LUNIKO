import { z } from "zod";
import { registerNode } from "../registry";

export const webhookTriggerConfigSchema = z.object({
  method: z.enum(["GET", "POST", "PUT"]).default("POST"),
  path: z.string().default(""),
});

registerNode({
  type: "webhookTrigger",
  displayName: "Webhook Trigger",
  description: "Inicia o workflow ao receber um HTTP request (Fase 5)",
  category: "trigger",
  icon: "Webhook",
  color: "#6366f1",
  inputs: [],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: webhookTriggerConfigSchema,
  defaultData: { method: "POST", path: "" },
});
