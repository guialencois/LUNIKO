import { describe, it, expect, vi, afterEach } from "vitest";
import { callN8nCalendarWebhook } from "./calendar";

describe("callN8nCalendarWebhook", () => {
  const payload = { summary: "Atendimento", startTime: "2026-11-01T14:00:00", endTime: "2026-11-01T14:30:00" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("succeeded: 2xx with a parseable id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "evt_123" }), { status: 200 }))
    );

    const result = await callN8nCalendarWebhook("https://n8n.example/webhook/cal", payload, "key1");

    expect(result).toEqual({ kind: "succeeded", providerReference: "evt_123" });
  });

  it("succeeded: id can be a number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: 42 }), { status: 200 }))
    );

    const result = await callN8nCalendarWebhook("https://n8n.example/webhook/cal", payload, "key1");

    expect(result).toEqual({ kind: "succeeded", providerReference: "42" });
  });

  it("failed: a 4xx is a definitive rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }))
    );

    const result = await callN8nCalendarWebhook("https://n8n.example/webhook/cal", payload, "key1");

    expect(result).toEqual({
      kind: "failed",
      code: "http_400",
      message: "n8n webhook rejected the request (HTTP 400)",
    });
  });

  it("unknown: a 5xx is not a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal error", { status: 500 }))
    );

    const result = await callN8nCalendarWebhook("https://n8n.example/webhook/cal", payload, "key1");

    expect(result).toEqual({ kind: "unknown", reason: "HTTP 500" });
  });

  it("unknown: a 2xx with no id in the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );

    const result = await callN8nCalendarWebhook("https://n8n.example/webhook/cal", payload, "key1");

    expect(result).toEqual({ kind: "unknown", reason: "response had no event id" });
  });

  it("unknown: a 2xx with a body that isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 }))
    );

    const result = await callN8nCalendarWebhook("https://n8n.example/webhook/cal", payload, "key1");

    expect(result).toEqual({ kind: "unknown", reason: "response body was not valid JSON" });
  });

  it("unknown: fetch itself throwing (network error, timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );

    const result = await callN8nCalendarWebhook("https://n8n.example/webhook/cal", payload, "key1");

    expect(result).toEqual({ kind: "unknown", reason: "ECONNRESET" });
  });

  it("sends the idempotency key as a header and the payload as JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "evt_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await callN8nCalendarWebhook("https://n8n.example/webhook/cal", payload, "the-idempotency-key");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://n8n.example/webhook/cal",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Idempotency-Key": "the-idempotency-key" }),
        body: JSON.stringify(payload),
      })
    );
  });
});
