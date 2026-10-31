import { z } from "zod";
import { registerNode } from "../registry";

/**
 * UI/registry only, same status as google-calendar.ts, google-sheets.ts and
 * ai-agent.ts — no executor registered yet.
 *
 * Unlike those, this one should NOT be built as a quick bolt-on once it's
 * time to implement it. A conversion call to Meta is an external effect in
 * exactly the sense Fase 10 (lib/execution/effects.ts, EffectRunner,
 * EXTERNAL_EFFECT_* error codes) exists for — same category as the Mercado
 * Pago provider under server/execution/effects/providers/mercadopago/: it
 * has a real-world side effect Meta's side can't be asked "did this already
 * happen?" about after a crash mid-call, so it needs the same
 * idempotency/businessKey handling, not a bare fetch(). Model its effect
 * provider after mercadopago's, not after a generic HTTP call.
 *
 * What a real implementation sends (confirmed against Meta's Conversions
 * API for Business Messaging docs, Oct 2026):
 *
 *   POST https://graph.facebook.com/v16.0/{datasetId}/events?access_token=...
 *   { "data": [{
 *       "event_name": "Purchase",              // or another allowed name —
 *                                               // see eventName below
 *       "event_time": <unix seconds>,
 *       "action_source": "business_messaging",
 *       "messaging_channel": "whatsapp",
 *       "user_data": {
 *         "whatsapp_business_account_id": "<WABA_ID>",
 *         "ctwa_clid": "<from the lead's stored referral>"
 *       },
 *       "custom_data": { "currency": "...", "value": ... }
 *   }] }
 *
 * The access token (whatsapp_business_management +
 * whatsapp_business_manage_events permissions) is a secret — it belongs in
 * an env var read server-side (same pattern as WHATSAPP_APP_SECRET in
 * lib/env.ts), never in a node's stored config.
 *
 * ctwa_clid itself needs NO new capture code: the WhatsApp Webhook Trigger
 * already carries it today, inside the first inbound message's `raw` field
 * (raw.referral.ctwa_clid — lib/whatsapp/parse.ts passes the whole message
 * through with .passthrough(), and Meta attaches `referral` there once
 * WhatsApp Business ads-attribution is turned on). What's missing is
 * somewhere to persist that ctwa_clid against the lead's phone number until
 * the sale closes, days or weeks later, and a way to look it up again at
 * that point — that's a product decision (Sheets row? a real leads table?),
 * not an engine gap.
 */
export const metaConversionsApiConfigSchema = z.object({
  /** Meta's allowlist for action_source "business_messaging" is narrower
   *  than the standard pixel CAPI — only these are accepted. */
  eventName: z
    .enum([
      "Purchase",
      "LeadSubmitted",
      "QualifiedLead",
      "InitiateCheckout",
      "AddToCart",
      "ViewContent",
      "OrderCreated",
      "OrderShipped",
      "OrderDelivered",
      "OrderCanceled",
      "OrderReturned",
      "CartAbandoned",
      "RatingProvided",
      "ReviewProvided",
    ])
    .default("Purchase"),
  /** Expression-evaluated against the incoming item, same as other node
   *  configs — where to read the stored ctwa_clid for this lead from. */
  ctwaClidSource: z.string().default(""),
  currency: z.string().default("BRL"),
  /** Expression-evaluated against the incoming item — the sale value. */
  value: z.string().default(""),
});

export type MetaConversionsApiConfig = z.infer<typeof metaConversionsApiConfigSchema>;

registerNode({
  type: "metaConversionsApi",
  displayName: "Meta Conversions API",
  description:
    "Reporta uma conversão (ex.: Purchase) de volta pro Meta Ads, atribuída pelo ctwa_clid (sem executor ainda)",
  category: "action",
  icon: "Target",
  color: "#1877f2",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: metaConversionsApiConfigSchema,
  defaultData: { eventName: "Purchase", ctwaClidSource: "", currency: "BRL", value: "" },
});
