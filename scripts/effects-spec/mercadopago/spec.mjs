// Fase 10.5B-1 — o CONTRATO do adaptador Mercado Pago, rodando o módulo REAL
// compilado (server/execution/effects/providers/mercadopago/contract.ts).
// Nenhuma chamada HTTP, nenhuma credencial: só entradas e saídas puras.
// Rode via ./scripts/effects-spec/mercadopago/run.sh.
import {
  MERCADOPAGO_CREATE_PAYMENT_OPERATION, MERCADOPAGO_CREATE_PAYMENT_ENDPOINT, MERCADOPAGO_IDEMPOTENCY_HEADER_NAME,
  validatePaymentRequest, toMercadoPagoPaymentBody, effectPayloadFor, classifyPaymentObservation,
  providerReferenceFromPaymentId, outcomeFromThrown, isRunnerIdempotencyKey,
  DEFINITIVE_400_CAUSE_CODES, MercadoPagoContractError,
} from "./out/server/execution/effects/providers/mercadopago/contract.js";

let pass = 0, fail = 0;
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
const check = (label, ok, detail = "") => {
  if (ok) { pass++; log(`PASS  ${label.padEnd(70)}${detail}`); }
  else { fail++; log(`FAIL  ${label.padEnd(70)}${detail}`); }
};
const section = (t) => log(`\n== ${t} ==`);
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// Uma chave como a do runner (sha256 hex) — aqui fixa, sem derivar nada.
const KEY = "a3f1c2d4e5b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
const OTHER_KEY = "0".repeat(64);
// Valores com forma de segredo, para provar que NUNCA chegam a um outcome.
const SECRET_TOKEN = "APP_USR-1234567890123456-092512-0123456789abcdef0123456789abcdef-123456789";
const CARD_TOKEN = "ff8080814c11e237014c1ff593b57b4d";
const EMAIL = "pagador@example.com";
const req = (o = {}) => ({ amountCents: 2450, paymentMethodId: "visa", installments: 1, cardToken: CARD_TOKEN, payerEmail: EMAIL, description: "Pedido 42", ...o });
const res = (status, body) => ({ kind: "response", status, body });
const payment = (o = {}) => ({ id: 20359978, status: "approved", status_detail: "accredited", external_reference: KEY, ...o });
const classify = (obs, key = KEY) => classifyPaymentObservation(obs, key);
const isUnknown = (o) => o && o.kind === "unknown" && typeof o.reason === "string" && o.reason.length > 0;
const FORBIDDEN = [SECRET_TOKEN, CARD_TOKEN, EMAIL, "Bearer", "Authorization", "authorization", "Cookie", "cookie",
  "X-Idempotency-Key", KEY, "transaction_amount", "payer", "token"];
const leaks = (outcome) => { const s = JSON.stringify(outcome); return FORBIDDEN.filter((f) => s.includes(f)); };

// =====================================================================
section("1. Identidade da operação");
check("operação é mercadopago.payment.create", MERCADOPAGO_CREATE_PAYMENT_OPERATION === "mercadopago.payment.create");
check("endpoint POST /v1/payments", MERCADOPAGO_CREATE_PAYMENT_ENDPOINT.method === "POST" && MERCADOPAGO_CREATE_PAYMENT_ENDPOINT.path === "/v1/payments");
check("nome do header de idempotência (só o nome)", MERCADOPAGO_IDEMPOTENCY_HEADER_NAME === "X-Idempotency-Key");
check("chave do runner: 64 hex aceita", isRunnerIdempotencyKey(KEY));
check("chave do runner: UUID/maiúsculas/curta recusadas",
  !isRunnerIdempotencyKey("bb51f99b-750e-4088-84dc-0ed582e4606f") && !isRunnerIdempotencyKey(KEY.toUpperCase()) && !isRunnerIdempotencyKey("abc"));

// =====================================================================
section("2. Validação do request interno");
check("payload válido aceito", validatePaymentRequest(req()).ok === true);
check("pix sem cardToken e sem description aceito", validatePaymentRequest(req({ paymentMethodId: "pix", cardToken: undefined, description: undefined })).ok === true);
const invalid = [
  ["amountCents 0", { amountCents: 0 }], ["amountCents negativo", { amountCents: -1 }],
  ["amountCents fracionário", { amountCents: 24.5 }], ["amountCents string", { amountCents: "2450" }],
  ["amountCents NaN", { amountCents: NaN }], ["installments 0", { installments: 0 }],
  ["installments fracionário", { installments: 1.5 }], ["paymentMethodId vazio", { paymentMethodId: "" }],
  ["paymentMethodId com espaço", { paymentMethodId: "vi sa" }], ["payerEmail sem @", { payerEmail: "x" }],
  ["payerEmail com espaço na borda", { payerEmail: " a@b.c" }], ["description com controle", { description: "a\nb" }],
  ["description longa", { description: "x".repeat(257) }], ["cardToken vazio", { cardToken: "" }],
  ["campo extra (workspaceId)", { workspaceId: "ws-1" }],
];
for (const [label, o] of invalid) check(`recusado: ${label}`, validatePaymentRequest(req(o)).ok === false);
check("recusado: não-objeto", validatePaymentRequest(null).ok === false && validatePaymentRequest("x").ok === false);
{
  const v = validatePaymentRequest(req({ payerEmail: "segredo-nao-ecoar" }));
  check("erro de validação não ecoa o valor", v.ok === false && !JSON.stringify(v).includes("segredo-nao-ecoar"));
}

// =====================================================================
section("3. Mapeamento request interno -> corpo do Mercado Pago");
{
  const body = toMercadoPagoPaymentBody(req(), KEY);
  check("transaction_amount = centavos / 100", body.transaction_amount === 24.5);
  check("1999 centavos -> 19.99 exato no JSON", JSON.stringify(toMercadoPagoPaymentBody(req({ amountCents: 1999 }), KEY).transaction_amount) === "19.99");
  check("payment_method_id, installments", body.payment_method_id === "visa" && body.installments === 1);
  check("token do cartão vai SÓ no corpo do provedor", body.token === CARD_TOKEN);
  check("payer.email", body.payer && body.payer.email === EMAIL && Object.keys(body.payer).length === 1);
  check("external_reference = chave idempotente do runner", body.external_reference === KEY);
  check("binary_mode sempre true", body.binary_mode === true);
  check("description", body.description === "Pedido 42");
  const keys = Object.keys(body).sort().join(",");
  check("nenhum campo além dos previstos", keys === "binary_mode,description,external_reference,installments,payer,payment_method_id,token,transaction_amount", keys);
  const pix = toMercadoPagoPaymentBody(req({ paymentMethodId: "pix", cardToken: undefined, description: undefined }), KEY);
  check("pix: sem token, sem description", !("token" in pix) && !("description" in pix));
  check("corpo não carrega header/credencial", !JSON.stringify(body).match(/Authorization|Bearer|X-Idempotency|APP_USR/));
  check("determinístico: mesma entrada, mesmo corpo", JSON.stringify(toMercadoPagoPaymentBody(req(), KEY)) === JSON.stringify(body));
  const e1 = throws(() => toMercadoPagoPaymentBody(req({ amountCents: 0 }), KEY));
  check("request inválido: lança MercadoPagoContractError", e1 instanceof MercadoPagoContractError);
  const e2 = throws(() => toMercadoPagoPaymentBody(req(), "bb51f99b-750e-4088-84dc-0ed582e4606f"));
  check("chave que não é a do runner: recusada", e2 instanceof MercadoPagoContractError);
  const e3 = throws(() => toMercadoPagoPaymentBody(req({ payerEmail: "segredo-nao-ecoar" }), KEY));
  check("mensagem de erro não ecoa o valor", e3 && !String(e3.message).includes("segredo-nao-ecoar"));
}
{
  const p = effectPayloadFor(req());
  check("payload do efeito (fingerprint) sem token do cartão", !JSON.stringify(p).includes(CARD_TOKEN));
  check("payload do efeito sem e-mail do pagador", !JSON.stringify(p).includes(EMAIL));
  check("payload do efeito tem o que identifica o pedido", p.amountCents === 2450 && p.paymentMethodId === "visa" && p.installments === 1);
  check("payload do efeito igual com token/e-mail diferentes",
    JSON.stringify(effectPayloadFor(req({ cardToken: "outro", payerEmail: "b@c.d" }))) === JSON.stringify(p));
  check("payload do efeito muda com o valor", JSON.stringify(effectPayloadFor(req({ amountCents: 2451 }))) !== JSON.stringify(p));
}

// =====================================================================
section("4. Resposta -> ProviderCallOutcome: succeeded só com confirmação positiva");
{
  const ok = classify(res(201, payment()));
  check("201 approved com id e external_reference -> succeeded", ok.kind === "succeeded" && ok.providerReference === "20359978", JSON.stringify(ok));
  check("200 approved -> succeeded (schema da referência lista 200)", classify(res(200, payment())).kind === "succeeded");
  check("id como string de dígitos -> succeeded", classify(res(201, payment({ id: "20359978" }))).kind === "succeeded");
  check("approved sem id -> unknown", isUnknown(classify(res(201, payment({ id: undefined })))));
  check("approved com id 0 / negativo / fracionário -> unknown",
    [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2].every((id) => isUnknown(classify(res(201, payment({ id }))))));
  check("approved com id não numérico (token) -> unknown", isUnknown(classify(res(201, payment({ id: SECRET_TOKEN })))));
  check("approved com external_reference de OUTRA operação -> unknown", isUnknown(classify(res(201, payment({ external_reference: OTHER_KEY })))));
  check("approved sem external_reference -> unknown", isUnknown(classify(res(201, payment({ external_reference: undefined })))));
  check("approved com status em maiúsculas -> unknown", isUnknown(classify(res(201, payment({ status: "APPROVED" })))));
  check("chave esperada inválida -> unknown, mesmo com approved", isUnknown(classify(res(201, payment()), "x")));
}

section("5. failed só com recusa definitiva e código do provedor");
{
  const rej = classify(res(201, payment({ status: "rejected", status_detail: "cc_rejected_insufficient_amount" })));
  check("rejected + status_detail -> failed", rej.kind === "failed" && rej.code === "rejected:cc_rejected_insufficient_amount", JSON.stringify(rej));
  check("rejected sem status_detail -> unknown", isUnknown(classify(res(201, payment({ status: "rejected", status_detail: undefined })))));
  check("rejected com status_detail vazio/forma estranha -> unknown",
    ["", "CC REJECTED", "x".repeat(80), 12.5].every((d) => isUnknown(classify(res(201, payment({ status: "rejected", status_detail: d }))))));
  check("rejected de outra operação -> unknown", isUnknown(classify(res(201, payment({ status: "rejected", status_detail: "cc_rejected_other_reason", external_reference: OTHER_KEY })))));
  const v400 = classify(res(400, { message: "x", error: "bad_request", status: 400, cause: [{ code: 2072, description: "Invalid value for transaction_amount." }] }));
  check("400 com código documentado (2072) -> failed", v400.kind === "failed" && v400.code === "http_400:2072", JSON.stringify(v400));
  check("400 com código como string ('4292') -> failed", classify(res(400, { cause: [{ code: "4292" }] })).kind === "failed");
  check("400 com vários códigos definitivos -> failed", classify(res(400, { cause: [{ code: 4000 }, { code: 4002 }] })).kind === "failed");
  check("403 com código documentado (3002) -> failed", classify(res(403, { cause: [{ code: 3002 }] })).kind === "failed");
  check("403 pa_unauthorized_result_from_policies -> failed", classify(res(403, { cause: [{ code: "pa_unauthorized_result_from_policies" }] })).kind === "failed");
  check("failed nunca copia texto livre do provedor",
    !JSON.stringify(v400).includes("Invalid value") && !JSON.stringify(rej).includes("description"));
}

section("6. Todo o resto é unknown — nunca failed");
{
  check("timeout -> unknown", isUnknown(classify({ kind: "timeout" })));
  check("erro de rede -> unknown", isUnknown(classify({ kind: "network_error" })));
  for (const s of [500, 502, 503, 504, 599]) check(`${s} -> unknown`, isUnknown(classify(res(s, { cause: [{ code: 2072 }] }))));
  check("corpo ilegível (200) -> unknown", isUnknown(classify({ kind: "unreadable", status: 200 })));
  check("corpo ilegível (400) -> unknown", isUnknown(classify({ kind: "unreadable", status: 400 })));
  check("exceção -> unknown", isUnknown(classify({ kind: "exception", error: new TypeError("boom") })));
  check("outcomeFromThrown -> unknown", isUnknown(outcomeFromThrown(new Error("x"))));
  check("exceção não-Error (string) -> unknown", isUnknown(classify({ kind: "exception", error: "boom" })));
  const ambiguous = ["pending", "in_process", "authorized", "in_mediation", "cancelled", "refunded", "charged_back", "algo_novo"];
  for (const st of ambiguous) check(`2xx status ${st} -> unknown`, isUnknown(classify(res(201, payment({ status: st })))));
  const pend = classify(res(201, payment({ status: "in_process" })));
  check("pendente: unknown com o id do pagamento (reconciliação)", isUnknown(pend) && pend.reason.includes("20359978"), JSON.stringify(pend));
  check("2xx sem corpo / corpo array / corpo string -> unknown",
    [undefined, null, [], "ok", 42].every((b) => isUnknown(classify(res(201, b)))));
  check("400 com código de falha de etapa (2004) -> unknown", isUnknown(classify(res(400, { cause: [{ code: 2004 }] }))));
  check("400 com código de falha de etapa (2007) -> unknown", isUnknown(classify(res(400, { cause: [{ code: 2007 }] }))));
  check("400 com 6033 (User unavailable) -> unknown", isUnknown(classify(res(400, { cause: [{ code: 6033 }] }))));
  check("400 com código não documentado -> unknown", isUnknown(classify(res(400, { cause: [{ code: 9999 }] }))));
  check("400 misturando definitivo e não documentado -> unknown", isUnknown(classify(res(400, { cause: [{ code: 2072 }, { code: 2004 }] }))));
  check("400 sem cause / cause vazio / forma desconhecida -> unknown",
    [{}, { cause: [] }, { cause: "2072" }, { cause_error: [{ code: 2072 }] }, { cause: [{ codigo: 2072 }] }, { cause: [null] }]
      .every((b) => isUnknown(classify(res(400, b)))));
  check("400 com código em forma de segredo -> unknown", isUnknown(classify(res(400, { cause: [{ code: SECRET_TOKEN }] }))));
  check("401 (sem código documentado) -> unknown", isUnknown(classify(res(401, { message: "unauthorized use of live credentials" }))));
  check("403 com código não documentado -> unknown", isUnknown(classify(res(403, { cause: [{ code: 2072 }] }))));
  for (const s of [202, 204, 301, 404, 409, 422, 429]) check(`HTTP ${s} -> unknown`, isUnknown(classify(res(s, payment()))));
  check("status HTTP inválido -> unknown", [0, 99, 600, 201.5, "201", NaN].every((s) => isUnknown(classify(res(s, payment())))));
  check("observação nula / tipo desconhecido -> unknown", isUnknown(classify(null)) && isUnknown(classify({ kind: "outra" })));
  const hostile = { get id() { throw new Error(SECRET_TOKEN); } };
  const h = classify(res(201, hostile));
  check("getter que lança -> unknown, sem o texto da exceção", isUnknown(h) && !JSON.stringify(h).includes(SECRET_TOKEN));
}

// =====================================================================
section("7. provider_reference: só referência não secreta");
check("número positivo -> dígitos", providerReferenceFromPaymentId(20359978) === "20359978");
check("string de dígitos -> ela mesma", providerReferenceFromPaymentId("123") === "123");
check("token de acesso -> null", providerReferenceFromPaymentId(SECRET_TOKEN) === null);
check("card token hex -> null", providerReferenceFromPaymentId(CARD_TOKEN) === null);
check("e-mail / Bearer / vazio / zero à esquerda -> null",
  [EMAIL, "Bearer abc", "", "0123", " 123", "123 ", "1e5"].every((v) => providerReferenceFromPaymentId(v) === null));
check("objeto / boolean / null -> null", [{}, true, null, undefined].every((v) => providerReferenceFromPaymentId(v) === null));
check("referência de succeeded só tem dígitos", /^\d+$/.test(classify(res(201, payment())).providerReference));

// =====================================================================
section("8. Nada de header/token/payload/credencial em nenhum outcome");
{
  const secretBody = {
    ...payment(), headers: { Authorization: `Bearer ${SECRET_TOKEN}`, Cookie: "sid=abc" },
    payer: { email: EMAIL }, token: CARD_TOKEN, transaction_amount: 24.5,
    card: { first_six_digits: "503143", last_four_digits: "6351" }, message: SECRET_TOKEN,
  };
  const observations = [
    res(201, secretBody), res(201, { ...secretBody, status: "rejected", status_detail: "cc_rejected_other_reason" }),
    res(201, { ...secretBody, status: "pending" }), res(201, { ...secretBody, id: SECRET_TOKEN }),
    res(400, { message: SECRET_TOKEN, error: `Bearer ${SECRET_TOKEN}`, cause: [{ code: 2072, description: SECRET_TOKEN }] }),
    res(400, { message: SECRET_TOKEN, cause: [{ code: 9999, description: `Authorization: Bearer ${SECRET_TOKEN}` }] }),
    res(403, { cause: [{ code: 3002, description: `Cookie: sid=${SECRET_TOKEN}` }] }),
    res(500, secretBody), res(401, { message: SECRET_TOKEN }), { kind: "unreadable", status: 201 },
    { kind: "exception", error: new Error(`fetch failed: Authorization: Bearer ${SECRET_TOKEN}`) },
    { kind: "exception", error: Object.assign(new Error(SECRET_TOKEN), { name: `Bearer ${SECRET_TOKEN}` }) },
    { kind: "timeout" }, { kind: "network_error" },
  ];
  let clean = 0; const dirty = [];
  for (const o of observations) {
    const out = classify(o);
    const l = leaks(out);
    const extra = Object.keys(out).filter((k) => !["kind", "providerReference", "code", "message", "reason"].includes(k));
    if (l.length === 0 && extra.length === 0) clean++; else dirty.push(`${JSON.stringify(out)} vaza ${l.concat(extra)}`);
  }
  check(`nenhum de ${observations.length} outcomes carrega segredo/header/payload`, clean === observations.length, dirty.join(" | "));
  const outs = observations.map((o) => classify(o));
  check("outcomes cabem nos limites do runner (code<=100, texto<=500)",
    outs.every((o) => (o.code === undefined || o.code.length <= 100) && [o.message, o.reason].every((t) => t === undefined || t.length <= 500)));
  check("outcomes sem caractere de controle", outs.every((o) => !/[\u0000-\u001f\u007f]/.test(JSON.stringify(Object.values(o)))));
}

// =====================================================================
section("9. Tabela de códigos definitivos");
check("2004/2007/6033/1000 fora da lista definitiva", ["2004", "2007", "6033", "1000"].every((c) => !DEFINITIVE_400_CAUSE_CODES.has(c)));
check("4292 (X-Idempotency-Key nulo) é definitivo", DEFINITIVE_400_CAUSE_CODES.has("4292"));

const summary = `\n${pass} PASS, ${fail} FAIL`;
log(summary);
globalThis.__MP_SPEC__ = { pass, fail, lines };
if (typeof process !== "undefined" && fail > 0) process.exitCode = 1;
