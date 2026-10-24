import { z } from "zod";
import { registerNode } from "../registry";

/**
 * Fase 5A — ver docs/webhook-trigger.md.
 *
 * provider "generic": aceita só `method`, gera um item com method/query/
 * headers/body. provider "whatsapp": protocolo da Meta (desafio no GET,
 * assinatura no POST), um item por mensagem recebida; `method` é ignorado.
 *
 * `path` é da Fase 2 e não é mais usado — a URL é um token gerado no painel
 * do nó. Continua aceito para que documentos já salvos com ele sigam válidos.
 */
export const webhookTriggerConfigSchema = z.object({
  provider: z.enum(["generic", "whatsapp"]).default("generic"),
  method: z.enum(["GET", "POST", "PUT"]).default("POST"),
  path: z.string().optional(),
});

export type WebhookTriggerConfig = z.infer<typeof webhookTriggerConfigSchema>;

registerNode({
  type: "webhookTrigger",
  displayName: "Webhook Trigger",
  description: "Inicia o workflow ao receber uma chamada HTTP (genérica ou WhatsApp)",
  category: "trigger",
  icon: "Webhook",
  color: "#6366f1",
  inputs: [],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: webhookTriggerConfigSchema,
  defaultData: { provider: "generic", method: "POST" },
});
