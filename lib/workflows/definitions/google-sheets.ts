import { z } from "zod";
import { registerNode } from "../registry";

/**
 * UI/registry only — same status as google-calendar.ts: no executor
 * registered yet, so a workflow using this node fails cleanly with
 * "No executor registered for node type \"googleSheets\"" instead of
 * doing anything. See that file's comment for why (no OAuth credential
 * storage in this codebase yet).
 */
export const googleSheetsConfigSchema = z.object({
  spreadsheetId: z.string().default(""),
  sheetName: z.string().default("Sheet1"),
  /** One row to append. Each value is expression-evaluated against the
   *  incoming item at execution time, same as other node configs. */
  values: z.array(z.string()).default([]),
});

export type GoogleSheetsConfig = z.infer<typeof googleSheetsConfigSchema>;

registerNode({
  type: "googleSheets",
  displayName: "Google Sheets",
  description: "Adiciona uma linha numa planilha do Google Sheets (sem executor ainda)",
  category: "action",
  icon: "Sheet",
  color: "#0f9d58",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: googleSheetsConfigSchema,
  defaultData: { spreadsheetId: "", sheetName: "Sheet1", values: [] },
});
