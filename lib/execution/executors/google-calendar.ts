import { registerExecutor } from "./registry";
import { ExecutionErrorCode } from "../errors";
import { EffectIdentityError, validateBusinessKey } from "@/server/execution/effects/effect-key";
import { callN8nCalendarWebhook } from "@/server/execution/effects/providers/n8n/calendar";
import { serverEnv } from "@/lib/env";
import type { ExecutionItem, NodeExecutionResult, NodeExecutor } from "../types";
import type { ExternalEffectResult } from "../effects";

const OPERATION = "n8n.calendar.create_event";

/** Same shape of error mapping as mock-effect-executor.ts — kept in step
 *  with it deliberately, since that file is this project's own reference
 *  for what a real effect-using executor's error handling looks like. */
function errorFor(result: Exclude<ExternalEffectResult, { status: "succeeded" }>) {
  switch (result.status) {
    case "failed":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_FAILED,
        message: `n8n rejected the request (${result.code})`,
      };
    case "unknown":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_UNKNOWN,
        message: `The event may or may not have been created and needs explicit resolution: ${result.reason}`,
      };
    case "fenced":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_FENCED,
        message: "This attempt no longer owns the execution; nothing was sent",
      };
    case "payload_mismatch":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_PAYLOAD_MISMATCH,
        message: "The same event was requested with different content; nothing was sent",
      };
    case "not_attempted":
      return {
        code: ExecutionErrorCode.EXTERNAL_EFFECT_NOT_ATTEMPTED,
        message: `Nothing was sent: ${result.reason}`,
      };
  }
}

/** item.json[field], read as a string config falls back to when its own
 *  literal value is blank — see the "no expression engine" note in
 *  lib/workflows/definitions/google-calendar.ts. */
function fieldOrFallback(configValue: unknown, item: ExecutionItem, field: string): string {
  if (typeof configValue === "string" && configValue.length > 0) return configValue;
  const fromItem = item.json[field];
  return typeof fromItem === "string" ? fromItem : "";
}

const googleCalendarExecutor: NodeExecutor = {
  nodeType: "googleCalendar",
  async execute(context): Promise<NodeExecutionResult> {
    const start = performance.now();
    const fail = (code: string, message: string): NodeExecutionResult => ({
      status: "error",
      durationMs: Math.round(performance.now() - start),
      error: { code, message, nodeId: context.nodeId, nodeType: "googleCalendar", retryable: false },
    });

    const effects = context.effects;
    if (!effects) {
      return fail(
        ExecutionErrorCode.EXTERNAL_EFFECTS_UNAVAILABLE,
        "googleCalendar runs only on the queued (async) path, where an ambiguous outcome can be settled"
      );
    }

    const webhookUrl = serverEnv.N8N_CALENDAR_WEBHOOK_URL;
    if (!webhookUrl) {
      return fail(
        ExecutionErrorCode.EXTERNAL_EFFECT_NOT_CONFIGURED,
        "N8N_CALENDAR_WEBHOOK_URL is not set — point it at the Production URL of the n8n workflow that creates the event"
      );
    }

    const businessKeyField =
      typeof context.config.businessKeyField === "string" ? context.config.businessKeyField : "from";

    // Identity of EVERY item before the first effect — same reason as
    // mock-effect-executor.ts: one bad item must never fail the node after
    // earlier items already reached n8n.
    const businessKeys: string[] = [];
    for (const item of context.input.items) {
      try {
        businessKeys.push(validateBusinessKey(item.json[businessKeyField]));
      } catch (err) {
        if (err instanceof EffectIdentityError) {
          return fail(ExecutionErrorCode.BUSINESS_KEY_REQUIRED, err.message);
        }
        throw err;
      }
    }

    const output: ExecutionItem[] = [];
    for (let i = 0; i < context.input.items.length; i++) {
      const item = context.input.items[i]!;
      const businessKey = businessKeys[i]!;

      const payload = {
        summary: fieldOrFallback(context.config.summary, item, "summary"),
        description: fieldOrFallback(context.config.description, item, "description"),
        startTime: fieldOrFallback(context.config.startTime, item, "startTime"),
        endTime: fieldOrFallback(context.config.endTime, item, "endTime"),
      };

      let result: ExternalEffectResult;
      try {
        result = await effects.run(context.nodeId, {
          operation: OPERATION,
          businessKey,
          payload,
          perform: (idempotencyKey) => callN8nCalendarWebhook(webhookUrl, payload, idempotencyKey),
        });
      } catch {
        return fail(
          ExecutionErrorCode.EXTERNAL_EFFECT_UNKNOWN,
          "The state of the external operation could not be recorded; check the operation record"
        );
      }

      if (result.status !== "succeeded") {
        const { code, message } = errorFor(result);
        return fail(code, message);
      }

      output.push({
        json: {
          ...item.json,
          calendarEvent: { id: result.providerReference, replayed: result.replayed },
        },
      });
    }

    return {
      status: "success",
      output: { items: output },
      durationMs: Math.round(performance.now() - start),
    };
  },
};

registerExecutor(googleCalendarExecutor);
