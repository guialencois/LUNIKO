import { z } from "zod";
import { registerNode } from "../registry";

export const setConfigSchema = z.object({
  values: z.record(z.unknown()).default({}),
});

registerNode({
  type: "set",
  displayName: "Set",
  description: "Cria ou altera campos nos dados",
  category: "data",
  icon: "PencilLine",
  color: "#22c55e",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: setConfigSchema,
  defaultData: { values: {} },
});
