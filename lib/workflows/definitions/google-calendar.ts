import { z } from "zod";
import { registerNode } from "../registry";

/**
 * Executor: lib/execution/executors/google-calendar.ts. Runs through the
 * Fase 10 effect runner (context.effects), same as any external effect —
 * only available on the queued (worker) path, i.e. downstream of a trigger
 * like webhookTrigger, never from the synchronous Execute button.
 *
 * It does NOT call Google — this app still has no OAuth credential storage
 * for third-party APIs. It calls a fixed webhook URL (env var
 * N8N_CALENDAR_WEBHOOK_URL, never something the workflow author supplies)
 * belonging to a workflow the user builds in their own n8n, which does the
 * real Google Calendar call with n8n's own credentialed node. See
 * server/execution/effects/providers/n8n/calendar.ts for the adapter and
 * why this is the lighter-weight sibling of the Mercado Pago contract.
 *
 * No expression engine exists anywhere in this codebase yet (every other
 * "Fase 3+" node is explicit that this is deferred, on purpose — it's meant
 * to be built once, centrally, not improvised per node). So there is no
 * {{ }} templating here either: summary/description/startTime/endTime are
 * used as literal config strings when set, and when left blank ("") the
 * executor falls back to the same-named field on the incoming item
 * (item.json.summary, item.json.startTime, ...) — so an upstream node (a
 * Set node, say) can make this dynamic just by writing those exact keys,
 * with no new mechanism to build or learn.
 */
export const googleCalendarConfigSchema = z.object({
  calendarId: z.string().default("primary"),
  summary: z.string().default(""),
  description: z.string().default(""),
  /** ISO 8601, or blank to read item.json.startTime / .endTime instead. */
  startTime: z.string().default(""),
  endTime: z.string().default(""),
  /** Which field of each incoming item identifies the entity this event is
   *  for (e.g. "from" — the WhatsApp contact id) — required by the effect
   *  runner so a retry/reclaim can never attribute this event to a
   *  different lead. */
  businessKeyField: z.string().default("from"),
});

export type GoogleCalendarConfig = z.infer<typeof googleCalendarConfigSchema>;

registerNode({
  type: "googleCalendar",
  displayName: "Google Calendar",
  description: "Cria um evento no Google Calendar, via um workflow do seu n8n",
  category: "action",
  icon: "Calendar",
  color: "#4285f4",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: googleCalendarConfigSchema,
  defaultData: {
    calendarId: "primary",
    summary: "",
    description: "",
    startTime: "",
    endTime: "",
    businessKeyField: "from",
  },
});
