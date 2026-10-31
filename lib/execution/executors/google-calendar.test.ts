import { describe, it, expect, vi, beforeEach } from "vitest";

const mockServerEnv: { N8N_CALENDAR_WEBHOOK_URL?: string } = {};
vi.mock("@/lib/env", () => ({ serverEnv: mockServerEnv }));

import "./google-calendar"; // registers it
import { getExecutor } from "./registry";
import { makeContext } from "../test-utils";
import type { ExternalEffectResult, ExternalEffectSpec } from "../effects";

describe("googleCalendar executor", () => {
  const executor = getExecutor("googleCalendar")!;

  beforeEach(() => {
    mockServerEnv.N8N_CALENDAR_WEBHOOK_URL = undefined;
  });

  it("is registered", () => {
    expect(executor).toBeDefined();
  });

  it("fails with EXTERNAL_EFFECTS_UNAVAILABLE when context.effects is absent (sync path)", async () => {
    const context = makeContext({
      nodeType: "googleCalendar",
      input: { items: [{ json: { from: "55119" } }] },
    });

    const result = await executor.execute(context);

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("EXTERNAL_EFFECTS_UNAVAILABLE");
  });

  it("fails with EXTERNAL_EFFECT_NOT_CONFIGURED when N8N_CALENDAR_WEBHOOK_URL is unset", async () => {
    const context = makeContext({
      nodeType: "googleCalendar",
      input: { items: [{ json: { from: "55119" } }] },
      effects: { run: vi.fn() },
    });

    const result = await executor.execute(context);

    expect(result.error?.code).toBe("EXTERNAL_EFFECT_NOT_CONFIGURED");
  });

  it("fails with BUSINESS_KEY_REQUIRED when the configured field is missing from the item", async () => {
    mockServerEnv.N8N_CALENDAR_WEBHOOK_URL = "https://n8n.example/webhook/cal";
    const context = makeContext({
      nodeType: "googleCalendar",
      input: { items: [{ json: {} }] },
      effects: { run: vi.fn() },
    });

    const result = await executor.execute(context);

    expect(result.error?.code).toBe("BUSINESS_KEY_REQUIRED");
  });

  it("validates every item's business key before calling effects.run on any of them", async () => {
    mockServerEnv.N8N_CALENDAR_WEBHOOK_URL = "https://n8n.example/webhook/cal";
    const run = vi.fn(async (_nodeId: string, _spec: ExternalEffectSpec): Promise<ExternalEffectResult> => {
      throw new Error("should not be called in this test");
    });
    const context = makeContext({
      nodeType: "googleCalendar",
      input: { items: [{ json: { from: "55119" } }, { json: {} }] },
      effects: { run },
    });

    const result = await executor.execute(context);

    expect(result.error?.code).toBe("BUSINESS_KEY_REQUIRED");
    expect(run).not.toHaveBeenCalled();
  });

  it("on success, attaches calendarEvent to the item and calls effects.run once with the right operation/businessKey", async () => {
    mockServerEnv.N8N_CALENDAR_WEBHOOK_URL = "https://n8n.example/webhook/cal";
    const run = vi.fn(
      async (_nodeId: string, _spec: ExternalEffectSpec): Promise<ExternalEffectResult> => ({
        status: "succeeded",
        providerReference: "evt_1",
        replayed: false,
      })
    );
    const context = makeContext({
      nodeType: "googleCalendar",
      config: {
        summary: "Atendimento",
        startTime: "2026-11-01T14:00:00",
        endTime: "2026-11-01T14:30:00",
      },
      input: { items: [{ json: { from: "55119" } }] },
      effects: { run },
    });

    const result = await executor.execute(context);

    expect(result.status).toBe("success");
    expect(result.output?.items[0]?.json.calendarEvent).toEqual({ id: "evt_1", replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1].operation).toBe("n8n.calendar.create_event");
    expect(run.mock.calls[0]![1].businessKey).toBe("55119");
  });

  it("falls back to item.json fields when the matching config field is blank", async () => {
    mockServerEnv.N8N_CALENDAR_WEBHOOK_URL = "https://n8n.example/webhook/cal";
    const run = vi.fn(
      async (_nodeId: string, _spec: ExternalEffectSpec): Promise<ExternalEffectResult> => ({
        status: "succeeded",
        providerReference: "evt_2",
        replayed: false,
      })
    );
    const context = makeContext({
      nodeType: "googleCalendar",
      config: { summary: "", startTime: "", endTime: "" },
      input: {
        items: [
          {
            json: {
              from: "55119",
              summary: "Passeio Lagoa Azul",
              startTime: "2026-11-02T09:00:00",
              endTime: "2026-11-02T13:00:00",
            },
          },
        ],
      },
      effects: { run },
    });

    await executor.execute(context);

    expect(run.mock.calls[0]![1].payload).toEqual({
      summary: "Passeio Lagoa Azul",
      description: "",
      startTime: "2026-11-02T09:00:00",
      endTime: "2026-11-02T13:00:00",
    });
  });

  it("maps a failed effect to EXTERNAL_EFFECT_FAILED", async () => {
    mockServerEnv.N8N_CALENDAR_WEBHOOK_URL = "https://n8n.example/webhook/cal";
    const run = vi.fn(
      async (_nodeId: string, _spec: ExternalEffectSpec): Promise<ExternalEffectResult> => ({
        status: "failed",
        code: "http_400",
        message: "bad request",
        replayed: false,
      })
    );
    const context = makeContext({
      nodeType: "googleCalendar",
      input: { items: [{ json: { from: "55119" } }] },
      effects: { run },
    });

    const result = await executor.execute(context);

    expect(result.error?.code).toBe("EXTERNAL_EFFECT_FAILED");
  });

  it("maps an unknown effect to EXTERNAL_EFFECT_UNKNOWN (never to a failure)", async () => {
    mockServerEnv.N8N_CALENDAR_WEBHOOK_URL = "https://n8n.example/webhook/cal";
    const run = vi.fn(
      async (_nodeId: string, _spec: ExternalEffectSpec): Promise<ExternalEffectResult> => ({
        status: "unknown",
        reason: "timeout",
      })
    );
    const context = makeContext({
      nodeType: "googleCalendar",
      input: { items: [{ json: { from: "55119" } }] },
      effects: { run },
    });

    const result = await executor.execute(context);

    expect(result.error?.code).toBe("EXTERNAL_EFFECT_UNKNOWN");
  });
});
