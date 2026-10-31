import type { ProviderCallOutcome } from "@/lib/execution/effects";

/**
 * Adapter for "create a Google Calendar event", performed by a workflow
 * running in the user's own n8n instance rather than by this app: LUNIKO has no
 * SSRF-safe outbound HTTP policy yet, and n8n already has mature,
 * credentialed Google OAuth nodes. The destination is one fixed webhook
 * URL per workflow (an env var, never a value the workflow author
 * supplies), so this never becomes a general-purpose HTTP egress.
 *
 * LIGHTER STANDARD THAN mercadopago/contract.ts, ON PURPOSE. That adapter
 * handles money and earned a whole phase (10.5B-1) just for its outcome
 * contract, with a closed list of definitive Mercado Pago error codes. A
 * duplicated or lost calendar event is a real but much smaller cost than a
 * duplicated or lost payment, and this webhook's response shape is ours —
 * we told the n8n workflow to return `{{ $json }}` after its own node runs
 * (see the setup steps given to the user). So the classification here is
 * the simple, honest version of the same contract, not the elaborate one:
 *
 *   succeeded  2xx, body parses as JSON, and has a truthy `id` (the created
 *              event's id, which n8n's Google Calendar node always returns
 *              on success) — that id is the provider reference.
 *   failed     4xx. n8n/Google rejected the request outright; nothing was
 *              created. The status code is the only "code" we have, since
 *              n8n doesn't give us a documented closed list the way Mercado
 *              Pago does — so unlike mercadopago/contract.ts this is NOT
 *              restricted to a pre-vetted allowlist of codes. That is the
 *              real tradeoff of the lighter standard: faithful to what a
 *              generic webhook can tell us, not as rigorously justified.
 *   unknown    everything else — timeout (handled by the effect runner
 *              itself, above this function), network error, 5xx, a 2xx
 *              whose body doesn't parse or has no `id`.
 */

export interface N8nCalendarEventPayload {
  summary: string;
  description?: string;
  startTime: string;
  endTime: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function callN8nCalendarWebhook(
  webhookUrl: string,
  payload: N8nCalendarEventPayload,
  idempotencyKey: string
): Promise<ProviderCallOutcome> {
  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Forwarded for n8n workflows that want to de-dupe on their own
        // side too; this adapter's own correctness never depends on n8n
        // honouring it.
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : "fetch failed" };
  }

  if (response.status >= 400 && response.status < 500) {
    return {
      kind: "failed",
      code: `http_${response.status}`,
      message: `n8n webhook rejected the request (HTTP ${response.status})`,
    };
  }

  if (!response.ok) {
    return { kind: "unknown", reason: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unknown", reason: "response body was not valid JSON" };
  }

  const id = isRecord(body) ? body.id : undefined;
  if (typeof id !== "string" && typeof id !== "number") {
    return { kind: "unknown", reason: "response had no event id" };
  }

  return { kind: "succeeded", providerReference: String(id) };
}
