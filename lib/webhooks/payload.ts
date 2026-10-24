import { isSensitiveHttpHeader } from "@/lib/workflows/redaction";
import type { ExecutionItem } from "@/lib/execution/types";
import type { ParsedInboundMessage } from "@/lib/whatsapp/parse";

/**
 * Fase 5A: transforma o que chegou no webhook nos items de entrada do
 * workflow. Funções puras — sem banco, sem rede — para poder testar cada
 * formato sozinho. Ver docs/webhook-trigger.md.
 */

export interface IncomingHttpRequest {
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string;
}

/** provider "generic": um item com a request inteira, sem cabeçalhos sensíveis. */
export function buildGenericItems(request: IncomingHttpRequest): ExecutionItem[] {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!isSensitiveHttpHeader(name)) headers[name.toLowerCase()] = value;
  }

  let body: unknown = null;
  if (request.rawBody.length > 0) {
    const contentType = headers["content-type"] ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(request.rawBody);
      } catch {
        // JSON declarado mas inválido: entrega como texto em vez de recusar.
        // Quem decide o que fazer com isso é o workflow.
        body = request.rawBody;
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(request.rawBody));
    } else {
      body = request.rawBody;
    }
  }

  return [{ json: { method: request.method, query: request.query, headers, body } }];
}

/** provider "whatsapp": um item por mensagem recebida. */
export function buildWhatsappItems(messages: ParsedInboundMessage[]): ExecutionItem[] {
  return messages.map((m) => ({
    json: {
      phoneNumberId: m.phoneNumberId,
      displayPhoneNumber: m.displayPhoneNumber,
      messageId: m.waMessageId,
      from: m.contactWaId,
      contactName: m.contactName,
      type: m.messageType,
      text: m.text,
      sentAt: m.sentAt.toISOString(),
      raw: m.raw,
    },
  }));
}
