import { z } from "zod";

/**
 * Lê o corpo de um webhook da WhatsApp Cloud API e devolve só as mensagens
 * recebidas, já normalizadas. Função pura: não fala com banco nem com rede,
 * para poder ser testada sozinha.
 *
 * Formato (resumido) que a Meta manda:
 *   { object: "whatsapp_business_account",
 *     entry: [{ changes: [{ field: "messages",
 *       value: { metadata: { phone_number_id, display_phone_number },
 *                contacts: [{ wa_id, profile: { name } }],
 *                messages: [{ id, from, timestamp, type, ... }],
 *                statuses: [...] } }] }] }
 *
 * `statuses` (entregue, lida...) é ignorado nesta etapa. O schema é
 * tolerante de propósito (passthrough): a Meta acrescenta campos com
 * frequência e um campo novo não pode derrubar a gravação.
 */

const messageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.string().regex(/^\d+$/),
    type: z.string().min(1),
  })
  .passthrough();

const valueSchema = z
  .object({
    metadata: z
      .object({
        phone_number_id: z.string().min(1),
        display_phone_number: z.string().optional(),
      })
      .passthrough(),
    contacts: z
      .array(
        z
          .object({
            wa_id: z.string(),
            profile: z.object({ name: z.string().optional() }).passthrough().optional(),
          })
          .passthrough()
      )
      .optional(),
    messages: z.array(z.unknown()).optional(),
  })
  .passthrough();

const payloadSchema = z
  .object({
    object: z.string(),
    entry: z.array(
      z
        .object({
          changes: z.array(
            z.object({ field: z.string(), value: z.unknown() }).passthrough()
          ),
        })
        .passthrough()
    ),
  })
  .passthrough();

export interface ParsedInboundMessage {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  waMessageId: string;
  contactWaId: string;
  contactName: string | null;
  messageType: string;
  text: string | null;
  sentAt: Date;
  raw: Record<string, unknown>;
}

export interface ParseResult {
  isWhatsappPayload: boolean;
  messages: ParsedInboundMessage[];
  /** Mensagens que vieram mas não tinham o mínimo (id, from, timestamp, type). */
  skipped: number;
}

/** O texto legível de cada tipo, quando existe. */
export function extractText(message: Record<string, unknown>): string | null {
  const pick = (path: string[]): string | null => {
    let cur: unknown = message;
    for (const key of path) {
      if (cur === null || typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[key];
    }
    return typeof cur === "string" && cur.length > 0 ? cur : null;
  };

  switch (message.type) {
    case "text":
      return pick(["text", "body"]);
    case "image":
    case "video":
    case "document":
      return pick([message.type, "caption"]) ?? pick(["document", "filename"]);
    case "button":
      return pick(["button", "text"]);
    case "interactive":
      return (
        pick(["interactive", "button_reply", "title"]) ??
        pick(["interactive", "list_reply", "title"])
      );
    case "reaction":
      return pick(["reaction", "emoji"]);
    case "location": {
      const name = pick(["location", "name"]);
      const address = pick(["location", "address"]);
      return [name, address].filter(Boolean).join(" — ") || null;
    }
    default:
      return null;
  }
}

export function parseWhatsappWebhook(body: unknown): ParseResult {
  const payload = payloadSchema.safeParse(body);
  if (!payload.success || payload.data.object !== "whatsapp_business_account") {
    return { isWhatsappPayload: false, messages: [], skipped: 0 };
  }

  const messages: ParsedInboundMessage[] = [];
  let skipped = 0;

  for (const entry of payload.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = valueSchema.safeParse(change.value);
      if (!value.success) continue;

      const { metadata, contacts = [], messages: rawMessages = [] } = value.data;
      const nameByWaId = new Map(
        contacts.map((c) => [c.wa_id, c.profile?.name ?? null] as const)
      );

      for (const rawMessage of rawMessages) {
        const parsed = messageSchema.safeParse(rawMessage);
        if (!parsed.success) {
          skipped += 1;
          continue;
        }
        const m = parsed.data;
        const raw = rawMessage as Record<string, unknown>;
        messages.push({
          phoneNumberId: metadata.phone_number_id,
          displayPhoneNumber: metadata.display_phone_number ?? null,
          waMessageId: m.id,
          contactWaId: m.from,
          contactName: nameByWaId.get(m.from) ?? null,
          messageType: m.type,
          text: extractText(raw),
          sentAt: new Date(Number(m.timestamp) * 1000),
          raw,
        });
      }
    }
  }

  return { isWhatsappPayload: true, messages, skipped };
}
