// Mutações deliberadas do CONTRATO (contract.js compilado). Cada uma reintroduz
// um erro plausível; a spec TEM de falhar em todas. O trecho `old` é casado
// ignorando diferenças de espaço (tokens separados por \s+), no JS que o tsc emite.
export const CONTRACT_FILE = "server/execution/effects/providers/mercadopago/contract.js";

export const MUTATIONS = [
  { name: "timeout vira failed",
    old: 'case "timeout": return unknown(REASONS.timeout);',
    new: 'case "timeout": return { kind: "failed", code: "timeout", message: "timeout" };' },
  { name: "5xx vira failed",
    old: "if (status >= 500) return unknown(REASONS.serverError(status));",
    new: 'if (status >= 500) return { kind: "failed", code: "http_" + status, message: "server error" };' },
  { name: "corpo ilegível vira failed",
    old: "return unknown(REASONS.unreadable(safeStatus(observation.status)));",
    new: 'return { kind: "failed", code: "unreadable", message: "unreadable" };' },
  { name: "exceção vira failed",
    old: "return unknown(REASONS.exception(className(err)));",
    new: 'return { kind: "failed", code: "exception", message: "exception" };' },
  { name: "texto da exceção entra no outcome",
    old: "return unknown(REASONS.exception(className(err)));",
    new: "return unknown(REASONS.exception(err instanceof Error ? err.message : className(err)));" },
  { name: "sem o try/catch externo (getter hostil escapa)",
    old: "} catch (err) {",
    new: "} catch (err) { throw err;" },
  { name: "pending/in_process contam como succeeded",
    old: 'if (payStatus === "approved") return',
    new: 'if (payStatus === "approved" || payStatus === "pending" || payStatus === "in_process") return' },
  { name: "external_reference não é conferido",
    old: "if (p.external_reference !== expectedExternalReference) return unknown(REASONS.referenceMismatch);",
    new: "" },
  { name: "rejected sem status_detail vira failed",
    old: "if (detail === null) return unknown(REASONS.rejectedWithoutDetail(reference));",
    new: 'if (detail === null) return { kind: "failed", code: "rejected", message: "rejected" };' },
  { name: "400 com QUALQUER código vira failed",
    old: "if (codes === null || !codes.every((c) => allowed.has(c)))",
    new: "if (codes === null)" },
  { name: "400 sem código algum vira failed",
    old: "if (codes === null || !codes.every((c) => allowed.has(c))) return unknown(REASONS.undocumentedError(status));",
    new: 'if (codes === null || !codes.every((c) => allowed.has(c))) return { kind: "failed", code: "http_" + status, message: "refused" };' },
  { name: "2004 (falha de etapa) tratado como definitivo",
    old: '"7523",',
    new: '"7523", "2004",' },
  { name: "401 vira failed",
    old: "return unknown(REASONS.unexpectedStatus(status));",
    new: 'return status === 401 ? { kind: "failed", code: "http_401", message: "unauthorized" } : unknown(REASONS.unexpectedStatus(status));' },
  { name: "failed copia a descrição do provedor",
    old: "return { kind: \"failed\", code, message: `mercadopago: request refused by the provider (${code})` };",
    new: "return { kind: \"failed\", code, message: JSON.stringify(body) };" },
  { name: "referência aceita qualquer string",
    old: 'if (typeof id === "string" && PAYMENT_ID_DIGITS.test(id)) {',
    new: 'if (typeof id === "string" && id.length > 0) { return id;' },
  { name: "referência aceita número não inteiro/zero",
    old: "return Number.isSafeInteger(id) && id > 0 ? String(id) : null;",
    new: "return String(id);" },
  { name: "token do cartão e e-mail entram no payload do efeito",
    old: "installments: request.installments,",
    new: "installments: request.installments, cardToken: request.cardToken, payerEmail: request.payerEmail," },
  { name: "external_reference deixa de ser a chave do runner",
    old: "external_reference: idempotencyKey,",
    new: "external_reference: String(Date.now()) + idempotencyKey.slice(0, 8)," },
  { name: "binary_mode desligado",
    old: "binary_mode: true,",
    new: "binary_mode: false," },
  { name: "valor enviado em centavos em vez de reais",
    old: "transaction_amount: r.amountCents / 100,",
    new: "transaction_amount: r.amountCents," },
  { name: "validação aceita campo extra",
    old: 'if (!allowed.has(k)) return { ok: false, field: k, problem: "unknown field" };',
    new: "" },
  { name: "validação aceita valor fracionário",
    old: "!Number.isSafeInteger(r.amountCents) ||",
    new: "" },
];

/** Aplica `old` -> `new` casando tokens separados por espaço arbitrário. */
export function applyMutation(source, m) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(m.old.trim().split(/\s+/).map(esc).join("\\s+"));
  const hit = pattern.exec(source);
  if (!hit) return null;
  return source.slice(0, hit.index) + m.new + source.slice(hit.index + hit[0].length);
}
