import { z } from "zod";
import { registerNode } from "../registry";

/**
 * UI/registry only, same status as google-calendar.ts and
 * google-sheets.ts — no executor registered yet, fails cleanly with
 * "No executor registered for node type \"aiAgent\"" rather than calling
 * any model. Wiring a real call needs an LLM API key stored somewhere
 * this codebase doesn't yet have a place for (same gap as the Google
 * nodes: no generic "external credential" storage exists, only the
 * Mercado Pago-specific effect provider).
 *
 * Purposefully minimal config — just enough to represent "read the
 * incoming item, decide/classify/draft a reply with an LLM, pass the
 * result on" in the editor. A real implementation will need to settle
 * things this doesn't attempt: which provider, streaming vs. not, how
 * the prompt binds to upstream item data.
 */
export const aiAgentConfigSchema = z.object({
  systemPrompt: z.string().default(""),
  /** Expression-evaluated against the incoming item, same as other
   *  node configs — e.g. the WhatsApp/Instagram message text. */
  userPrompt: z.string().default(""),
});

export type AiAgentConfig = z.infer<typeof aiAgentConfigSchema>;

registerNode({
  type: "aiAgent",
  displayName: "AI Agent",
  description: "Usa um modelo de linguagem para decidir/responder (sem executor ainda)",
  category: "action",
  icon: "Bot",
  color: "#8b5cf6",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: aiAgentConfigSchema,
  defaultData: { systemPrompt: "", userPrompt: "" },
});
