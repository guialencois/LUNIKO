import { z } from "zod";
import { registerNode } from "../registry";

export const scheduleTriggerConfigSchema = z.object({
  scheduleType: z.enum(["interval", "cron"]).default("interval"),
  interval: z.number().int().positive().default(60),
});

registerNode({
  type: "scheduleTrigger",
  displayName: "Schedule Trigger",
  description: "Inicia o workflow periodicamente (Fase 5)",
  category: "trigger",
  icon: "Clock",
  color: "#6366f1",
  inputs: [],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: scheduleTriggerConfigSchema,
  defaultData: { scheduleType: "interval", interval: 60 },
});
