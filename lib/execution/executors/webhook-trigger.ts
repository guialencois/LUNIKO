import { registerExecutor } from "./registry";
import { defaultInitialInput } from "../data";
import type { NodeExecutor } from "../types";

/**
 * Fase 5A. Como o manualTrigger, este nó não FAZ nada: ele entrega adiante
 * o que o disparo trouxe. Todo o trabalho de receber a chamada — achar o
 * endpoint, conferir a assinatura, montar os items — acontece ANTES, em
 * server/webhooks/receive-webhook.ts, e o resultado chega aqui como a
 * entrada inicial (executions.trigger_payload). Ver docs/webhook-trigger.md.
 *
 * Num disparo manual este nó nunca é alcançado (não tem aresta de entrada e
 * não é o trigger do plano), então ele não precisa saber de onde veio.
 */
const webhookTriggerExecutor: NodeExecutor = {
  nodeType: "webhookTrigger",
  async execute(context) {
    const start = performance.now();
    const output = context.input.items.length > 0 ? context.input : defaultInitialInput();
    return {
      status: "success" as const,
      output,
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(webhookTriggerExecutor);
