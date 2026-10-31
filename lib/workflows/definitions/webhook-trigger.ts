import { z } from "zod";
import { registerNode } from "../registry";

/**
 * Fase 5A — ver docs/webhook-trigger.md.
 *
 * provider "generic": aceita só `method`, gera um item com method/query/
 * headers/body. provider "whatsapp": protocolo da Meta (desafio no GET,
 * assinatura no POST), um item por mensagem recebida; `method` é ignorado.
 *
 * provider "instagram": só existe no editor por enquanto. receive-webhook.ts
 * responde 501 NOT_IMPLEMENTED para ele de propósito — a verificação de
 * assinatura é a mesma HMAC da Meta que o whatsapp já usa
 * (lib/whatsapp/signature.ts), mas o formato do payload (entry[].messaging[]
 * em vez de entry[].changes[].value.messages[]) é diferente e ainda não tem
 * parser nem teste. Ligar de verdade é objetivo de um PR dedicado, não algo
 * para arriscar sem poder rodar a suíte de testes no mesmo commit.
 *
 * `path` é da Fase 2 e não é mais usado — a URL é um token gerado no painel
 * do nó. Continua aceito para que documentos já salvos com ele sigam válidos.
 */
export const webhookTriggerConfigSchema = z.object({
  provider: z.enum(["generic", "whatsapp", "instagram"]).default("generic"),
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
