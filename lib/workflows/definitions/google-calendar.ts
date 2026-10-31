import { z } from "zod";
import { registerNode } from "../registry";

/**
 * UI/registry only — there is no executor registered for "googleCalendar"
 * yet (see lib/execution/executors/registry.ts). Running a workflow that
 * contains this node fails cleanly with "No executor registered for node
 * type \"googleCalendar\"" (lib/execution/executor.ts), the same safe path
 * every unimplemented node type goes through — it does not silently no-op
 * or corrupt an execution.
 *
 * Making it actually create events needs a Google OAuth connection stored
 * per workspace (refresh token + calendar scope) — this codebase has no
 * credential-storage mechanism for third-party OAuth yet, only the
 * Mercado Pago API-key style effect provider under
 * server/execution/effects/providers/. That's real work for its own PR,
 * not something to improvise inside this one.
 */
export const googleCalendarConfigSchema = z.object({
  calendarId: z.string().default("primary"),
  summary: z.string().default(""),
  description: z.string().default(""),
  /** ISO 8601. Expression-evaluated against the incoming item at
   *  execution time, same as other node configs (Fase 3+). */
  startTime: z.string().default(""),
  endTime: z.string().default(""),
});

export type GoogleCalendarConfig = z.infer<typeof googleCalendarConfigSchema>;

registerNode({
  type: "googleCalendar",
  displayName: "Google Calendar",
  description: "Cria um evento no Google Calendar (sem executor ainda — ver comentário no arquivo)",
  category: "action",
  icon: "Calendar",
  color: "#4285f4",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: googleCalendarConfigSchema,
  defaultData: { calendarId: "primary", summary: "", description: "", startTime: "", endTime: "" },
});
