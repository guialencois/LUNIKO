import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { isValidMetaSignature } from "./signature";
import { parseWhatsappWebhook, extractText } from "./parse";

const SECRET = "segredo-falso-de-teste";
const sign = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("isValidMetaSignature", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  it("aceita a assinatura certa", () => {
    expect(isValidMetaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("recusa assinatura de outro segredo", () => {
    expect(isValidMetaSignature(body, sign(body, "outro"), SECRET)).toBe(false);
  });

  it("recusa corpo alterado depois de assinado", () => {
    expect(isValidMetaSignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("recusa cabeçalho ausente, sem prefixo ou malformado", () => {
    expect(isValidMetaSignature(body, null, SECRET)).toBe(false);
    expect(isValidMetaSignature(body, sign(body).slice(7), SECRET)).toBe(false);
    expect(isValidMetaSignature(body, "sha256=abc", SECRET)).toBe(false);
  });
});

function webhook(messages: unknown[], extra: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "123",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "559891223812", phone_number_id: "676942748829214" },
              contacts: [{ wa_id: "5598999990000", profile: { name: "Maria" } }],
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

describe("parseWhatsappWebhook", () => {
  it("normaliza uma mensagem de texto", () => {
    const result = parseWhatsappWebhook(
      webhook([
        { from: "5598999990000", id: "wamid.A", timestamp: "1761264000", type: "text", text: { body: "Oi, tem passeio amanhã?" } },
      ])
    );
    expect(result.isWhatsappPayload).toBe(true);
    expect(result.messages).toHaveLength(1);
    const m = result.messages[0];
    if (!m) throw new Error("esperava uma mensagem");
    expect(m).toMatchObject({
      phoneNumberId: "676942748829214",
      waMessageId: "wamid.A",
      contactWaId: "5598999990000",
      contactName: "Maria",
      messageType: "text",
      text: "Oi, tem passeio amanhã?",
    });
    expect(m.sentAt.toISOString()).toBe("2025-10-24T00:00:00.000Z");
  });

  it("ignora eventos só de status (entregue/lida)", () => {
    const result = parseWhatsappWebhook(
      webhook([], { statuses: [{ id: "wamid.X", status: "read" }] })
    );
    expect(result.isWhatsappPayload).toBe(true);
    expect(result.messages).toHaveLength(0);
  });

  it("pula mensagem sem o mínimo e conta", () => {
    const result = parseWhatsappWebhook(webhook([{ id: "wamid.B", type: "text" }]));
    expect(result.messages).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("não reconhece payload de outro produto", () => {
    expect(parseWhatsappWebhook({ object: "page", entry: [] }).isWhatsappPayload).toBe(false);
    expect(parseWhatsappWebhook("lixo").isWhatsappPayload).toBe(false);
  });
});

describe("extractText", () => {
  it("lê legenda de imagem, resposta de botão e reação", () => {
    expect(extractText({ type: "image", image: { caption: "Foto da lagoa" } })).toBe("Foto da lagoa");
    expect(extractText({ type: "interactive", interactive: { button_reply: { title: "Quero reservar" } } })).toBe("Quero reservar");
    expect(extractText({ type: "reaction", reaction: { emoji: "👍" } })).toBe("👍");
    expect(extractText({ type: "audio", audio: { id: "1" } })).toBeNull();
  });
});
