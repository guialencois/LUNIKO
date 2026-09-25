import { z } from "zod";
import { registerNode } from "../registry";

export const manualTriggerConfigSchema = z.object({});

registerNode({
  type: "manualTrigger",
  displayName: "Manual Trigger",
  description: "Inicia o workflow manualmente",
  category: "trigger",
  icon: "MousePointerClick",
  color: "#6366f1",
  inputs: [],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: manualTriggerConfigSchema,
  defaultData: {},
});
