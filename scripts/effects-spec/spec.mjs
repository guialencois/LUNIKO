// Fases 10 e 10.5A — roda os MÓDULOS REAIS compilados (effect-key,
// effect-decision, effect-runner, MockExternalEffect, executor mock,
// runExecutionPlan; 10.5A: resolution.ts com zod, effect-view.ts).
// Só o effect-repository é o stub em memória (effect-repository.memory.ts,
// ao lado deste arquivo). Rode via ./scripts/effects-spec/run.sh.
import {
  memdb, createQueuedExecution, createSyncExecution, claim, reclaim, finish, abandon, cancel,
  resolveUnknown, adoptEffectOperation, beginEffectOperation, recordEffectOutcome,
  reserveEffectOperation, rawUpdate,
} from "./out/server/execution/effects/effect-repository.js";
import {
  validateResolveEffectRequest, ResolveRequestValidationError, statusForResolution,
  RESOLUTION_COOLING_PERIOD_SECONDS, RESOLVER_ROLES, TERMINAL_EXECUTION_STATUSES,
} from "./out/server/execution/effects/resolution.js";
import { toEffectOperationView, toEffectAttemptView } from "./out/server/execution/effects/effect-view.js";
import { createEffectRunner, EFFECT_CALL_TIMEOUT_MS } from "./out/server/execution/effects/effect-runner.js";
import {
  deriveIdempotencyKey, fingerprintPayload, canonicalJson, validateBusinessKey,
  validateOperation, EffectIdentityError, EFFECT_KEY_VERSION,
} from "./out/server/execution/effects/effect-key.js";
import { decideEffectAction } from "./out/server/execution/effects/effect-decision.js";
import { MockExternalEffect } from "./out/server/execution/effects/test-support/mock-external-effect.js";
import {
  createMockEffectExecutor, MOCK_EFFECT_OPERATION, MOCK_EFFECT_NODE_TYPE,
} from "./out/server/execution/effects/test-support/mock-effect-executor.js";
import { runExecutionPlan } from "./out/lib/execution/executor.js";
import { registerExecutor } from "./out/lib/execution/executors/registry.js";
import "./out/lib/execution/executors/manual-trigger.js";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label.padEnd(66)}${detail}`); }
  else { fail++; console.log(`FAIL  ${label.padEnd(66)}${detail}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
const opsFor = (eid) => [...memdb.operations.values()].filter((o) => o.executionId === eid);
const eventsFor = (opId) => memdb.attempts.filter((a) => a.operationId === opId);
const evs = (opId) => eventsFor(opId).map((a) => `${a.event}@${a.actor === "worker" ? a.epoch : a.actor}${a.applied ? "" : "(não aplicado)"}`).join(" ");
const shape = (o) => JSON.stringify({ s: o.status, own: o.ownerEpoch, began: o.beganEpoch, ref: o.providerReference, err: o.lastError });
const spec = (p, behavior, o = {}) => ({
  operation: o.operation ?? MOCK_EFFECT_OPERATION,
  businessKey: o.businessKey ?? "lead-42",
  payload: o.payload ?? { text: "Olá", recipient: o.businessKey ?? "lead-42" },
  perform: p.perform(behavior),
});
function fresh(eid) {
  createQueuedExecution(eid);
  const epoch = claim(eid);
  return { epoch, runner: createEffectRunner({ executionId: eid, workspaceId: "ws-1", epoch, callTimeoutMs: 600_000 }) };
}
// Fase 10.5A: uma pessoa só decide com evidência e justificativa — e o
// pedido passa pelo validador REAL (resolution.ts), como na rota. Estes
// testes são do runner: o resfriamento é dispensado (0 s); a seção 6 o testa.
const NOW = { coolingPeriodSeconds: 0 };
const sent = (ref) => validateResolveEffectRequest({
  resolution: "confirmed_sent", providerReference: ref,
  evidence: { source: "provider_dashboard" }, justification: "confirmado no painel do provedor" });
const notSent = () => validateResolveEffectRequest({
  resolution: "confirmed_not_sent",
  evidence: { source: "provider_dashboard", detail: "nenhuma mensagem para lead-42" },
  justification: "não achei no painel do provedor" });
function nextEpoch(eid) {
  if (!reclaim(eid)) throw new Error("reclaim recusado");
  const epoch = claim(eid);
  return { epoch, runner: createEffectRunner({ executionId: eid, workspaceId: "ws-1", epoch, callTimeoutMs: 600_000 }) };
}

// =====================================================================
section("1. Identidade — chave e fingerprint (módulo real, puro)");
{
  const base = { executionId: "exec-1", nodeId: "send", businessKey: "lead-42", operation: "whatsapp.send_template" };
  const k = deriveIdempotencyKey(base);
  check("D  mesma identidade -> mesma chave (sem época na entrada)", k === deriveIdempotencyKey({ ...base }) && /^[0-9a-f]{64}$/.test(k));
  check("E  node diferente -> chave diferente", k !== deriveIdempotencyKey({ ...base, nodeId: "send-2" }));
  check("F  businessKey diferente -> chave diferente", k !== deriveIdempotencyKey({ ...base, businessKey: "lead-43" }));
  check("G  execução diferente -> chave diferente", k !== deriveIdempotencyKey({ ...base, executionId: "exec-2" }));
  check("   operação diferente -> chave diferente", k !== deriveIdempotencyKey({ ...base, operation: "whatsapp.send_text" }));
  check("H  época não é entrada: extra 'epoch' ignorado, chave igual", k === deriveIdempotencyKey({ ...base, epoch: 7, claimAttempts: 3 }));
  check("   tupla, não concatenação: ('a:b','c') != ('a','b:c')",
    deriveIdempotencyKey({ executionId: "a:b", nodeId: "c", businessKey: "x", operation: "o" }) !==
    deriveIdempotencyKey({ executionId: "a", nodeId: "b:c", businessKey: "x", operation: "o" }));
  check("   versão da chave é v1", EFFECT_KEY_VERSION === "v1");
  check("   chave não contém a businessKey em claro", !k.includes("lead-42"));

  const refuse = (v) => { try { validateBusinessKey(v); return "aceitou"; } catch (e) { return e instanceof EffectIdentityError ? e.code : "outro"; } };
  check("   businessKey ausente -> BUSINESS_KEY_REQUIRED", refuse(undefined) === "BUSINESS_KEY_REQUIRED" && refuse(null) === "BUSINESS_KEY_REQUIRED");
  check("   businessKey vazia -> BUSINESS_KEY_REQUIRED", refuse("") === "BUSINESS_KEY_REQUIRED");
  check("   índice numérico não serve de businessKey", refuse(3) === "BUSINESS_KEY_REQUIRED" && refuse(0) === "BUSINESS_KEY_REQUIRED");
  check("   espaços nas bordas: recusa (não normaliza)", refuse(" lead-42") === "BUSINESS_KEY_REQUIRED" && refuse("lead-42 ") === "BUSINESS_KEY_REQUIRED");
  check("   caractere de controle: recusa", refuse("lead\u000042") === "BUSINESS_KEY_REQUIRED" && refuse("lead\n42") === "BUSINESS_KEY_REQUIRED");
  check("   limite 256: 256 aceita, 257 recusa", refuse("x".repeat(256)) === "aceitou" && refuse("x".repeat(257)) === "BUSINESS_KEY_REQUIRED");
  check("   caixa preservada: 'Lead-42' != 'lead-42'", deriveIdempotencyKey({ ...base, businessKey: "Lead-42" }) !== k);
  let opErr = ""; try { validateOperation(""); } catch (e) { opErr = e.code; }
  check("   operação vazia -> INVALID_OPERATION", opErr === "INVALID_OPERATION");

  check("   fingerprint ignora ordem de chaves", fingerprintPayload({ a: 1, b: { c: 2, d: [1, 2] } }) === fingerprintPayload({ b: { d: [1, 2], c: 2 }, a: 1 }));
  check("   fingerprint distingue conteúdo", fingerprintPayload({ text: "Olá" }) !== fingerprintPayload({ text: "Olá!" }));
  check("   fingerprint distingue ordem de array", fingerprintPayload({ l: [1, 2] }) !== fingerprintPayload({ l: [2, 1] }));
  check("   canonicalJson: undefined some em objeto, vira null em array", canonicalJson({ a: undefined, b: [undefined] }) === '{"b":[null]}');
  let nf = ""; try { fingerprintPayload({ x: Infinity }); } catch (e) { nf = e.code; }
  check("   número não finito é recusado", nf === "PAYLOAD_NOT_JSON");
}

// =====================================================================
section("2. Tabela de decisão (módulo real, puro)");
{
  const fp = "fp-1";
  const op = (o) => ({ status: "reserved", ownerEpoch: 1, beganEpoch: null, payloadFingerprint: fp, providerReference: null, lastError: null, ...o });
  const d = (o, epoch = 1, f = fp) => decideEffectAction(o, epoch, f).kind;
  check("   nada existe -> reserve", decideEffectAction(null, 1, fp).kind === "reserve");
  check("   dono mais novo -> fenced (antes de qualquer outra coisa)", d(op({ ownerEpoch: 3, status: "succeeded", providerReference: "r" }), 2) === "fenced");
  check("   payload diferente -> payload_mismatch (antes do replay)", d(op({ status: "succeeded", providerReference: "r" }), 1, "fp-2") === "payload_mismatch");
  check("   succeeded -> replay_succeeded", d(op({ status: "succeeded", beganEpoch: 1, providerReference: "r" })) === "replay_succeeded");
  check("   failed -> replay_failed (sem retry automático)", d(op({ status: "failed", beganEpoch: 1, lastError: { code: "X", message: "y" } })) === "replay_failed");
  check("   unknown -> report_unknown (nunca reenvia)", d(op({ status: "unknown", beganEpoch: 1 })) === "report_unknown");
  check("   unknown de época antiga -> report_unknown, não adopt", d(op({ status: "unknown", beganEpoch: 1, ownerEpoch: 1 }), 2) === "report_unknown");
  check("   reserved, dono antigo -> adopt", d(op({ ownerEpoch: 1 }), 2) === "adopt");
  check("   reserved, dono sou eu -> begin", d(op({ ownerEpoch: 2 }), 2) === "begin");
  check("   in_flight, dono antigo -> adopt", d(op({ status: "in_flight", beganEpoch: 1 }), 2) === "adopt");
  check("   in_flight, dono sou eu -> reentered_in_flight", d(op({ status: "in_flight", beganEpoch: 2, ownerEpoch: 2 }), 2) === "reentered_in_flight");
}

// =====================================================================
section("3. MockExternalEffect — os sete cenários (runner real, repo em memória)");

// ---- success ----
{
  memdb.reset(); const p = new MockExternalEffect(); const { runner } = fresh("s1");
  const r = await runner.run("send", spec(p, "success"));
  const [op] = opsFor("s1");
  check("success: resultado succeeded, replayed=false", r.status === "succeeded" && r.replayed === false && r.providerReference === "mock-msg-1");
  check("success: operação succeeded, referência do provedor", op.status === "succeeded" && op.providerReference === "mock-msg-1");
  check("success: 1 envio no ledger", p.ledger.length === 1 && p.acceptedFor(op.idempotencyKey) === 1);
  check("success: histórico reserved -> began -> succeeded", evs(op.id) === "reserved@1 began@1 succeeded@1", evs(op.id));
  check("success: chave repassada ao provedor = chave da operação", p.ledger[0].idempotencyKey === op.idempotencyKey);
}

// ---- failure ----
{
  memdb.reset(); const p = new MockExternalEffect(); const { runner } = fresh("f1");
  const r = await runner.run("send", spec(p, "failure"));
  const [op] = opsFor("f1");
  check("failure: resultado failed com o código do provedor", r.status === "failed" && r.code === "MOCK_REJECTED" && r.replayed === false);
  check("failure: operação failed, sem referência", op.status === "failed" && op.providerReference === null && op.lastError.code === "MOCK_REJECTED");
  check("failure: ledger vazio (nada aconteceu fora)", p.ledger.length === 0 && p.calls === 1);
  const again = await runner.run("send", spec(p, "success"));
  check("failure: repetir -> replay do failed, sem nova chamada", again.status === "failed" && again.replayed === true && p.calls === 1);
  const { runner: r2 } = nextEpoch("f1");
  const e2 = await r2.run("send", spec(p, "success"));
  check("failure: nova época -> replay, sem retry automático", e2.status === "failed" && e2.replayed === true && p.calls === 1);
}

// ---- timeout (+ timeout antes do aceite: indistinguível) ----
{
  memdb.reset(); const p = new MockExternalEffect();
  const a = fresh("t1"); const b = fresh("t2");
  const ra = await a.runner.run("send", spec(p, "timeout"));
  const rb = await b.runner.run("send", spec(p, "timeout_before_accept"));
  const [opA] = opsFor("t1"); const [opB] = opsFor("t2");
  check("timeout: resultado unknown (nunca failed)", ra.status === "unknown" && rb.status === "unknown");
  check("timeout: operação unknown, began=1", opA.status === "unknown" && opA.beganEpoch === 1);
  check("timeout: ledger — aceito num caso, não no outro", p.acceptedFor(opA.idempotencyKey) === 1 && p.acceptedFor(opB.idempotencyKey) === 0);
  check("timeout: os dois casos deixam o MESMO estado gravado", shape(opA) === shape(opB), shape(opA));
  check("timeout: e o mesmo histórico", evs(opA.id) === evs(opB.id), evs(opA.id));
  const callsBefore = p.calls;
  const again = await a.runner.run("send", spec(p, "success"));
  const n2 = nextEpoch("t1"); const e2 = await n2.runner.run("send", spec(p, "success"));
  const n3 = nextEpoch("t1"); const e3 = await n3.runner.run("send", spec(p, "success"));
  check("timeout: unknown permanece (mesma época, época 2, época 3)", [again, e2, e3].every((x) => x.status === "unknown") && opsFor("t1")[0].status === "unknown");
  check("timeout: nenhuma nova chamada ao provedor", p.calls === callsBefore && p.acceptedFor(opA.idempotencyKey) === 1);
  const alive = await resolveUnknown(opA.id, "user-1", sent("mock-msg-1"), NOW);
  check("timeout: execução viva -> ninguém resolve", alive.outcome === "execution_active" && alive.executionStatus === "running");
  finish("t1", n3.epoch, "error");
  const resolved = await resolveUnknown(opA.id, "user-1", sent("mock-msg-1"), NOW);
  check("timeout: só a resolução explícita sai de unknown", resolved.outcome === "resolved" && resolved.operation.status === "succeeded"
    && resolved.operation.providerReference === "mock-msg-1" && resolved.operation.resolution === "confirmed_sent");
  const last = eventsFor(opA.id).at(-1);
  check("timeout: resolução registrada com ator humano", last.event === "resolved" && last.actor === "user" && last.actorUserId === "user-1" && last.epoch === null);
  const twice = await resolveUnknown(opA.id, "user-1", notSent(), NOW);
  check("timeout: resolver de novo é recusado (só parte de unknown)", twice.outcome === "not_unknown" && twice.status === "succeeded");
}

// ---- crash-before-request, antes do commit do begin ----
{
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("c1");
  memdb.faults.beforeBegin = async (epoch) => (epoch === 1 ? "crash" : "proceed");
  void a.runner.run("send", spec(p, "success"));
  await settle();
  const [op1] = opsFor("c1"); const idBefore = op1.id; const keyBefore = op1.idempotencyKey;
  check("crash-before (antes do begin): operação ficou reserved", op1.status === "reserved" && op1.beganEpoch === null && p.calls === 0);
  const b = nextEpoch("c1");
  const r = await b.runner.run("send", spec(p, "success"));
  const ops = opsFor("c1"); const op2 = ops[0];
  check("crash-before (antes do begin): época 2 envia UMA vez", r.status === "succeeded" && r.replayed === false && p.ledger.length === 1);
  check("B  duas épocas, uma operação", ops.length === 1 && op2.id === idBefore);
  check("H  reclaim não muda a identidade lógica", op2.idempotencyKey === keyBefore);
  check("D  retry usa a mesma chave (a do reserve da época 1)", p.ledger[0].idempotencyKey === keyBefore);
  check("crash-before (antes do begin): histórico", evs(op2.id) === "reserved@1 adopted@2 began@2 succeeded@2", evs(op2.id));
  // um runner NOVO da época 1: o antigo continua preso no crash simulado, e
  // a coalescência (mesma chave, mesmo runner) esperaria por ele — como um
  // processo parado de verdade.
  const zombie = createEffectRunner({ executionId: "c1", workspaceId: "ws-1", epoch: 1, callTimeoutMs: 600_000 });
  const z = await zombie.run("send", spec(p, "success"));
  check("   época 1 (zumbi) depois disso: fenced, não replay", z.status === "fenced" && p.ledger.length === 1);
}

// ---- crash-before-request, depois do commit do begin ----
let shapeCrashBefore;
{
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("c2");
  void a.runner.run("send", spec(p, "crash_before_request"));
  await settle();
  const [op1] = opsFor("c2");
  check("crash-before (após begin): in_flight, nada aceito", op1.status === "in_flight" && op1.beganEpoch === 1 && p.ledger.length === 0);
  const b = nextEpoch("c2");
  const r = await b.runner.run("send", spec(p, "success"));
  const [op2] = opsFor("c2");
  check("crash-before (após begin): época 2 NÃO envia -> unknown", r.status === "unknown" && p.ledger.length === 0 && p.calls === 1);
  check("crash-before (após begin): operação unknown (custo do at-most-once)", op2.status === "unknown" && op2.ownerEpoch === 2 && op2.beganEpoch === 1);
  shapeCrashBefore = { shape: shape(op2), evs: evs(op2.id) };
}

// ---- crash-after-request ----
{
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("c3");
  void a.runner.run("send", spec(p, "crash_after_request"));
  await settle();
  check("crash-after: provedor aceitou, operação in_flight", p.ledger.length === 1 && opsFor("c3")[0].status === "in_flight");
  const b = nextEpoch("c3");
  const r = await b.runner.run("send", spec(p, "success"));
  const [op] = opsFor("c3");
  check("crash-after: época 2 não reenvia -> unknown", r.status === "unknown" && p.ledger.length === 1 && p.calls === 1);
  check("J  caso ambíguo representado como unknown", op.status === "unknown");
  check("crash-after == crash-before (após begin): mesmo estado gravado", shape(op) === shapeCrashBefore.shape, shape(op));
  check("crash-after == crash-before (após begin): mesmo histórico", evs(op.id) === shapeCrashBefore.evs, evs(op.id));
}

// ---- late-success ----
{
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("l1");
  const late = a.runner.run("send", spec(p, "late_success"));
  await settle();
  const b = nextEpoch("l1");
  const r2 = await b.runner.run("send", spec(p, "success"));
  check("late-success: época 2 vê unknown e não reenvia", r2.status === "unknown" && p.ledger.length === 1);
  p.releaseLate();
  const r1 = await late;
  const [op] = opsFor("l1");
  check("late-success: fato tardio da época 1 é aceito (autoria)", r1.status === "succeeded" && op.status === "succeeded" && op.providerReference === "mock-msg-1");
  check("late-success: dono segue sendo a época 2", op.ownerEpoch === 2 && op.beganEpoch === 1);
  check("late-success: histórico", evs(op.id) === "reserved@1 began@1 adopted@2 unknown@2 succeeded@1", evs(op.id));
  check("late-success: época 1 NÃO finaliza a execução", finish("l1", 1, "success") === false);
  const again = await b.runner.run("send", spec(p, "success"));
  check("late-success: época 2 depois: replay, ledger continua 1", again.status === "succeeded" && again.replayed === true && p.ledger.length === 1);
}
{ // fato tardio depois de uma resolução humana: fica no histórico, não reescreve a decisão
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("l2");
  const late = a.runner.run("send", spec(p, "late_success"));
  await settle();
  const b = nextEpoch("l2");
  await b.runner.run("send", spec(p, "success"));
  finish("l2", b.epoch, "error");
  const [op0] = opsFor("l2");
  const judged = await resolveUnknown(op0.id, "user-1", notSent(), NOW);
  p.releaseLate(); await late;
  const [op] = opsFor("l2"); const last = eventsFor(op.id).at(-1);
  check("late após resolução: o fato do provedor substitui o juízo humano", judged.outcome === "resolved" && op.status === "succeeded"
    && op.providerReference === "mock-msg-1" && op.resolvedByUserId === null && op.resolution === null);
  check("late após resolução: histórico guarda os dois", evs(op.id) === "reserved@1 began@1 adopted@2 unknown@2 resolved@user succeeded@1"
    && last.detail.overridesResolution?.status === "failed" && last.detail.overridesResolution?.resolution === "confirmed_not_sent", evs(op.id));
}

// ---- duplicate-attempt ----
{
  memdb.reset(); const p = new MockExternalEffect(); const { runner } = fresh("d1");
  const first = await runner.run("send", spec(p, "success"));
  const second = await runner.run("send", spec(p, "success"));
  check("duplicate (mesma época, em sequência): replay", first.replayed === false && second.status === "succeeded" && second.replayed === true);
  check("A  duas tentativas da mesma época, uma operação", opsFor("d1").length === 1 && p.ledger.length === 1);
}
{
  // provedor LENTO: a segunda corrida alcança a primeira com a chamada no ar
  memdb.reset(); const p = new MockExternalEffect(); const { runner } = fresh("d2");
  const both = Promise.all([runner.run("send", spec(p, "late_success")), runner.run("send", spec(p, "late_success"))]);
  await settle(); p.releaseLate();
  const [x, y] = await both;
  const statuses = [x, y].map((r) => r.status + (r.replayed ? "(replay)" : "")).sort().join(",");
  check("duplicate (mesma época, concorrente): um envio só", p.ledger.length === 1 && p.calls === 1 && opsFor("d2").length === 1, statuses);
  check("   o segundo compartilha a tentativa (replay, sem unknown espúrio)", statuses === "succeeded,succeeded(replay)");
}
{ // a barreira do begin não depende da coalescência: dois runners da MESMA
  // época (como dois processos) disputando a mesma operação
  memdb.reset(); const p = new MockExternalEffect();
  createQueuedExecution("d2b"); const ep = claim("d2b");
  const r1 = createEffectRunner({ executionId: "d2b", workspaceId: "ws-1", epoch: ep, callTimeoutMs: 600_000 });
  const r2 = createEffectRunner({ executionId: "d2b", workspaceId: "ws-1", epoch: ep, callTimeoutMs: 600_000 });
  const both = Promise.all([r1.run("send", spec(p, "late_success")), r2.run("send", spec(p, "late_success"))]);
  await settle(); p.releaseLate();
  const res = (await both).map((r) => r.status).sort().join(",");
  check("duplicate (mesma época, dois runners): UM envio", p.ledger.length === 1 && p.calls === 1, res);
  const [op] = opsFor("d2b");
  const again = await beginEffectOperation({ operationId: op.id, executionId: "d2b", epoch: ep });
  check("   begin repetido pelo próprio dono: stale", again.outcome === "stale");
}
{ // zumbi reservou e parou antes do begin; o novo dono assume e envia
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("d3");
  let releaseZombie;
  memdb.faults.beforeBegin = (epoch) => epoch === 1 ? new Promise((r) => { releaseZombie = () => r("proceed"); }) : Promise.resolve("proceed");
  const zombie = a.runner.run("send", spec(p, "success"));
  await settle();
  const b = nextEpoch("d3");
  const r2 = await b.runner.run("send", spec(p, "success"));
  releaseZombie();
  const r1 = await zombie;
  check("duplicate (zumbi + dono): dono envia, zumbi fica fenced", r2.status === "succeeded" && r1.status === "fenced");
  check("duplicate (zumbi + dono): ledger = 1", p.ledger.length === 1 && p.calls === 1);
}
{ // zumbi que nem chegou a reservar
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("d4");
  nextEpoch("d4");
  const r = await a.runner.run("send", spec(p, "success", { businessKey: "lead-7" }));
  check("duplicate (zumbi sem reserva): fenced no reserve, nada criado", r.status === "fenced" && opsFor("d4").length === 0 && p.calls === 0);
}
{ // mesma identidade, conteúdo diferente
  memdb.reset(); const p = new MockExternalEffect(); const { runner } = fresh("d5");
  await runner.run("send", spec(p, "success"));
  const r = await runner.run("send", spec(p, "success", { payload: { text: "outra mensagem", recipient: "lead-42" } }));
  check("duplicate com payload diferente: payload_mismatch, nada enviado", r.status === "payload_mismatch" && p.calls === 1);
}

// =====================================================================
section("4. A–K restantes");
{ // E, F, G no runner: identidades diferentes não colidem
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("k1"); const b = fresh("k2");
  await a.runner.run("send-a", spec(p, "success"));
  await a.runner.run("send-b", spec(p, "success"));
  await a.runner.run("send-a", spec(p, "success", { businessKey: "lead-43" }));
  await b.runner.run("send-a", spec(p, "success"));
  const keys = new Set([...memdb.operations.values()].map((o) => o.idempotencyKey));
  check("E  node diferente -> operação diferente (runner)", opsFor("k1").filter((o) => o.businessKey === "lead-42").length === 2);
  check("F  businessKey diferente -> operação diferente (runner)", opsFor("k1").length === 3);
  check("G  execuções diferentes não colidem (runner)", opsFor("k2").length === 1 && keys.size === 4 && p.ledger.length === 4);
}
{ // I. época antiga não finaliza a operação da nova
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("i1");
  memdb.faults.beforeBegin = async (epoch) => (epoch === 1 ? "crash" : "proceed");
  void a.runner.run("send", spec(p, "success"));
  await settle();
  const b = nextEpoch("i1");
  const pending = b.runner.run("send", spec(p, "late_success"));
  await settle();
  const [op] = opsFor("i1");
  memdb.faults.beforeBegin = null; // o crash da época 1 já aconteceu; agora ela "acorda"
  const forged = await recordEffectOutcome({ operationId: op.id, executionId: "i1", epoch: 1, outcome: { kind: "succeeded", providerReference: "forjado-pela-epoca-1" } });
  check("I  época 1 não grava fato numa chamada da época 2", forged.status === "in_flight" && forged.providerReference === null);
  check("I  a tentativa fica no histórico como não aplicada", eventsFor(op.id).at(-1).applied === false);
  const adopt1 = await adoptEffectOperation({ operationId: op.id, executionId: "i1", epoch: 1 });
  const begin1 = await beginEffectOperation({ operationId: op.id, executionId: "i1", epoch: 1 });
  check("I  época 1 também não assume nem inicia (fenced)", adopt1.outcome === "fenced" && begin1.outcome === "fenced");
  p.releaseLate(); const r = await pending; const [done] = opsFor("i1");
  check("I  a época 2 conclui com a própria referência", r.status === "succeeded" && done.providerReference === "mock-msg-1");
}
{ // J. todas as formas de ambiguidade viram unknown
  memdb.reset(); const p = new MockExternalEffect();
  const t = fresh("j1"); const rt = await t.runner.run("send", spec(p, "throw_after_accept"));
  check("J  adapter lança após o aceite -> unknown", rt.status === "unknown" && opsFor("j1")[0].status === "unknown");
  const s = fresh("j2"); const rs = await s.runner.run("send", spec(p, "success_without_reference"));
  check("J  sucesso sem referência -> unknown (nunca succeeded sem evidência)", rs.status === "unknown" && opsFor("j2")[0].status === "unknown");

  memdb.faults.recordFailures = 2;
  const g = fresh("j3"); const rg = await g.runner.run("send", spec(p, "success"));
  check("   gravar o fato falha 2x e passa na 3ª: succeeded", rg.status === "succeeded" && opsFor("j3")[0].status === "succeeded");

  memdb.faults.recordFailures = 3;
  const h = fresh("j4"); let threw = false;
  try { await h.runner.run("send", spec(p, "success")); } catch { threw = true; }
  check("   gravar o fato falha 3x: runner lança, operação fica in_flight", threw && opsFor("j4")[0].status === "in_flight");
  check("J  execução termina com operação em voo -> unknown (trigger)", finish("j4", h.epoch, "error") && opsFor("j4")[0].status === "unknown");
  const sys = eventsFor(opsFor("j4")[0].id).at(-1);
  check("   evento do sistema, sem época", sys.actor === "system" && sys.epoch === null && sys.detail.executionStatus === "error");

  memdb.faults.recordFailures = 0;
  // época 1 chama o provedor e morre; épocas 2 e 3 morrem antes de chegar
  // ao nó; o reaper esgota as tentativas e abandona. Ninguém adotou.
  const z = fresh("j5");
  void z.runner.run("send", spec(p, "crash_after_request")); await settle();
  nextEpoch("j5"); nextEpoch("j5");
  check("J  reaper abandona com operação em voo -> unknown",
    memdb.executions.get("j5").claimAttempts === 3 && abandon("j5") && opsFor("j5")[0].status === "unknown");

  const r6 = fresh("j6");
  memdb.faults.beforeBegin = async () => "crash";
  void r6.runner.run("send", spec(p, "success")); await settle();
  memdb.faults.beforeBegin = null;
  check("   operação só reservada NÃO vira unknown no término",
    finish("j6", r6.epoch, "error") && opsFor("j6")[0].status === "reserved");
}
{ // K. nenhum segredo nos registros
  memdb.reset(); const p = new MockExternalEffect(); const { runner } = fresh("k9");
  const secretPayload = { text: "Olá", authorization: "Bearer sk-live-SECRET123", apiKey: "sk-live-SECRET123", cookie: "session=abc123SECRET" };
  await runner.run("send", spec(p, "success", { payload: secretPayload }));
  await runner.run("send-2", spec(p, "failure", { payload: secretPayload }));
  await runner.run("send-3", spec(p, "timeout", { payload: secretPayload }));
  const dump = JSON.stringify([[...memdb.operations.values()], memdb.attempts]);
  check("K  registros não contêm o payload (só o hash)", !/SECRET|sk-live|Bearer|session=/.test(dump));
  check("K  fingerprint gravado é o hash do payload", [...memdb.operations.values()][0].payloadFingerprint === fingerprintPayload(secretPayload));
  check("K  nenhuma coluna guarda o payload", !("payload" in [...memdb.operations.values()][0]));
}

// =====================================================================
section("4b. Achados da revisão independente");
{ // #2: texto de exceção nunca é gravado (pode carregar token)
  memdb.reset(); const p = new MockExternalEffect(); const { runner } = fresh("r2");
  const leaky = { operation: MOCK_EFFECT_OPERATION, businessKey: "lead-42", payload: { text: "Olá" },
    perform: async () => { p.perform("success"); throw new TypeError('Headers.append: "Bearer EAAG-SECRET-TOKEN\r\nx" is an invalid header value.'); } };
  const r = await runner.run("send", leaky);
  const dump = JSON.stringify([[...memdb.operations.values()], memdb.attempts, r]);
  check("#2 exceção com token: nada do texto é gravado nem devolvido", r.status === "unknown" && !/EAAG|SECRET|Bearer|Headers\.append/.test(dump), r.reason);
  check("#2 ...só a classe do erro sobrevive", r.reason.endsWith("(TypeError)"));
}
{ // #7: NUL / surrogate solto não derrubam um resultado definitivo
  memdb.reset(); const { runner } = fresh("r7");
  const r = await runner.run("send", { operation: MOCK_EFFECT_OPERATION, businessKey: "lead-42", payload: {},
    perform: async () => ({ kind: "failed", code: "E\u0000X", message: "número inválido \uD83D" + "x".repeat(900) }) });
  const [op] = opsFor("r7");
  check("#7 failed com NUL e surrogate solto: segue failed, texto limpo", r.status === "failed" && op.status === "failed" &&
    !/\u0000/.test(JSON.stringify(op)) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(op.lastError.message) && op.lastError.message.length <= 500);
}
{ // #9: failed sem código do provedor não é evidência
  memdb.reset(); const { runner } = fresh("r9");
  const r = await runner.run("send", { operation: MOCK_EFFECT_OPERATION, businessKey: "lead-42", payload: {},
    perform: async () => ({ kind: "failed" }) });
  check("#9 failed sem código -> unknown", r.status === "unknown" && opsFor("r9")[0].status === "unknown");
  const { runner: r2 } = fresh("r9b");
  const rr = await r2.run("send", { operation: MOCK_EFFECT_OPERATION, businessKey: "lead-42", payload: {},
    perform: async () => ({ kind: "succeeded", providerReference: "wamid.1\u0000x" }) });
  check("   sucesso com referência corrompida -> unknown (evidência não é consertada)", rr.status === "unknown");
}
{ // #8: mesma chave em paralelo com payload diferente
  memdb.reset(); const p = new MockExternalEffect(); const { runner } = fresh("r8");
  const [a, b] = await Promise.all([
    runner.run("send", spec(p, "success")),
    runner.run("send", spec(p, "success", { payload: { text: "outra", recipient: "lead-42" } })),
  ]);
  check("#8 mesma chave em paralelo, payload diferente: payload_mismatch", a.status === "succeeded" && b.status === "payload_mismatch" && p.calls === 1);
}
{ // #10: prazo por chamada; resposta tardia ainda é fato
  memdb.reset(); const p = new MockExternalEffect();
  createQueuedExecution("r10"); const ep = claim("r10");
  const runner = createEffectRunner({ executionId: "r10", workspaceId: "ws-1", epoch: ep, callTimeoutMs: 30 });
  const t0 = Date.now();
  const r = await runner.run("send", spec(p, "late_success"));
  const waited = Date.now() - t0;
  check("#10 sem resposta no prazo -> unknown, sem esperar para sempre", r.status === "unknown" && waited < 1000 && opsFor("r10")[0].status === "unknown", `${waited}ms`);
  p.releaseLate(); await settle();
  check("#10 ...e a resposta que chega depois é gravada como fato", opsFor("r10")[0].status === "succeeded" && opsFor("r10")[0].providerReference === "mock-msg-1");
  check("   o prazo padrão existe e é finito", EFFECT_CALL_TIMEOUT_MS === 20_000);
  const r2 = await createEffectRunner({ executionId: "r10", workspaceId: "ws-1", epoch: ep, callTimeoutMs: 30 })
    .run("send-hang", spec(p, "crash_before_request"));
  check("#10 chamada que nunca responde: unknown no prazo", r2.status === "unknown");
}
{ // #6: fato/decisão presos à execução, não só ao número da época
  memdb.reset(); const p = new MockExternalEffect();
  const a = fresh("r6a"); const b = fresh("r6b");            // as duas na época 1
  memdb.faults.beforeBegin = async () => "crash";
  void b.runner.run("send", spec(p, "success")); await settle(); memdb.faults.beforeBegin = null;
  const [opB] = opsFor("r6b");
  const beginFromA = await beginEffectOperation({ operationId: opB.id, executionId: "r6a", epoch: 1 });
  const adoptFromA = await adoptEffectOperation({ operationId: opB.id, executionId: "r6a", epoch: 2 });
  check("#6 época 1 de OUTRA execução não inicia nem adota", beginFromA.outcome === "fenced" && adoptFromA.outcome === "fenced");
  await beginEffectOperation({ operationId: opB.id, executionId: "r6b", epoch: 1 });
  const forged = await recordEffectOutcome({ operationId: opB.id, executionId: "r6a", epoch: 1, outcome: { kind: "succeeded", providerReference: "forjado" } });
  check("#6 época 1 de OUTRA execução não grava fato", forged.status === "in_flight" && eventsFor(opB.id).at(-1).applied === false);
}
{ // #3: execução cancelada NA FILA com operação em voo
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("r3");
  void a.runner.run("send", spec(p, "crash_after_request")); await settle();
  reclaim("r3");                                                   // de volta para a fila
  check("#3 queued -> cancelled com operação em voo: vira unknown", cancel("r3") && opsFor("r3")[0].status === "unknown");
}
{ // #1: resolução humana ANTES de a chamada acontecer; o provedor aceita depois
  memdb.reset(); const p = new MockExternalEffect(); const a = fresh("r1");
  let wake; memdb.faults.beforeBegin = null;
  const gate = new Promise((r) => { wake = r; });
  const stalled = { operation: MOCK_EFFECT_OPERATION, businessKey: "lead-42", payload: { text: "Olá", recipient: "lead-42" },
    perform: async (k) => { await gate; return p.perform("success")(k); } };   // trava entre o begin e a chamada
  const pending = a.runner.run("send", stalled); await settle();
  nextEpoch("r1"); nextEpoch("r1");                                // épocas 2 e 3 morrem antes do nó
  abandon("r1");                                                   // o trigger: in_flight -> unknown
  const [op0] = opsFor("r1");
  const judged = await resolveUnknown(op0.id, "user-1", notSent(), NOW);
  wake(); const late = await pending;
  const [op] = opsFor("r1");
  check("#1 o worker acorda e envia DEPOIS de perder a posse (janela real)", judged.outcome === "resolved" && p.ledger.length === 1 && late.status === "succeeded");
  check("#1 ...e o registro diz a verdade: succeeded, não 'failed'", op.status === "succeeded" && op.providerReference === "mock-msg-1", evs(op.id));
  let threw = null;
  try { validateResolveEffectRequest({ resolution: "confirmed_sent", providerReference: "", evidence: { source: "provider_dashboard" }, justification: "vi no painel do provedor" }); }
  catch (e) { threw = e; }
  check("#5 confirmed_sent exige referência não vazia (validador real)",
    threw instanceof ResolveRequestValidationError && Boolean(threw.issues.fieldErrors.providerReference));
}

// =====================================================================
section("5. Ponta a ponta: runExecutionPlan real + executor mock");
{
  memdb.reset();
  const provider = new MockExternalEffect();
  const behaviors = new Map();
  registerExecutor(createMockEffectExecutor({ provider, behaviorFor: (key) => behaviors.get(key) ?? "success" }));
  const plan = {
    workflowId: "wf-1",
    nodes: [
      { nodeId: "t", nodeType: "manualTrigger", config: {} },
      { nodeId: "send", nodeType: MOCK_EFFECT_NODE_TYPE, config: { businessKeyField: "leadId", text: "Olá" } },
    ],
    edges: [{ id: "e1", source: "t", target: "send", sourceHandle: null, targetHandle: null }],
    entryNodes: ["t"], topologicalOrder: ["t", "send"], manualTriggerNodeId: "t",
  };
  const logger = { info() {}, warn() {}, error() {} };
  const leads = (...ids) => ({ items: ids.map((id) => ({ json: id === null ? { nome: "sem id" } : { leadId: id } })) });
  const run = (eid, epoch, input, withEffects = true) => runExecutionPlan(plan, {
    executionId: eid, workflowId: "wf-1", workspaceId: "ws-1", initialInput: input, logger,
    ...(withEffects ? { epoch, effects: createEffectRunner({ executionId: eid, workspaceId: "ws-1", epoch }) } : {}),
  });

  createQueuedExecution("x1"); const ep1 = claim("x1");
  const o1 = await run("x1", ep1, leads("lead-1", "lead-2", "lead-3"));
  const refs1 = o1.finalOutput?.items.map((i) => i.json.effect.providerReference).join(",");
  check("E2E worker: 3 leads -> 3 envios", o1.status === "success" && provider.ledger.length === 3, refs1);
  // o worker morre depois do nó e antes do finish; o reaper devolve à fila
  reclaim("x1"); const ep2 = claim("x1");
  const o2 = await run("x1", ep2, leads("lead-1", "lead-2", "lead-3"));
  const refs2 = o2.finalOutput?.items.map((i) => i.json.effect.providerReference).join(",");
  check("E2E reexecução do plano inteiro após reclaim: 0 envios novos", o2.status === "success" && provider.ledger.length === 3);
  check("E2E ...e cada item é replay, com a mesma referência", refs1 === refs2 && o2.finalOutput.items.every((i) => i.json.effect.replayed === true));

  createSyncExecution("x2");
  const o3 = await run("x2", 0, leads("lead-1"), false);
  check("E2E caminho síncrono: EXTERNAL_EFFECTS_UNAVAILABLE, nada enviado", o3.status === "error" && o3.error.code === "EXTERNAL_EFFECTS_UNAVAILABLE" && provider.ledger.length === 3);

  createQueuedExecution("x3"); const ep3 = claim("x3");
  const o4 = await run("x3", ep3, leads("lead-1", null, "lead-3"));
  check("E2E item sem businessKey: BUSINESS_KEY_REQUIRED antes de qualquer envio", o4.status === "error" && o4.error.code === "BUSINESS_KEY_REQUIRED" && opsFor("x3").length === 0 && provider.ledger.length === 3);

  createQueuedExecution("x4"); const ep4 = claim("x4");
  behaviors.set("lead-2", "timeout");
  const o5 = await run("x4", ep4, leads("lead-1", "lead-2", "lead-3"));
  check("E2E unknown no item 2: nó falha com EXTERNAL_EFFECT_UNKNOWN", o5.status === "error" && o5.error.code === "EXTERNAL_EFFECT_UNKNOWN" && o5.error.nodeId === "send");
  check("E2E ...item 1 enviado, item 3 nunca tentado", opsFor("x4").map((o) => `${o.businessKey}:${o.status}`).sort().join(",") === "lead-1:succeeded,lead-2:unknown");
  behaviors.clear();
  reclaim("x4"); const ep5 = claim("x4"); const before = provider.ledger.length;
  const o6 = await run("x4", ep5, leads("lead-1", "lead-2", "lead-3"));
  check("E2E ...nova época para no mesmo unknown, sem reenviar", o6.status === "error" && o6.error.code === "EXTERNAL_EFFECT_UNKNOWN" && provider.ledger.length === before);
}

// =====================================================================
section("6. Fase 10.5A — o pedido de resolução (resolution.ts real, zod)");
{
  const v = (body) => {
    try { return { ok: true, value: validateResolveEffectRequest(body) }; }
    catch (e) { if (!(e instanceof ResolveRequestValidationError)) throw e; return { ok: false, issues: e.issues }; }
  };
  // flatten(): fieldErrors por PRIMEIRO segmento do caminho (evidence.detail -> "evidence")
  const refusedAt = (body, field) => { const r = v(body); return !r.ok && (field === undefined || Boolean(r.issues.fieldErrors[field]?.length || (field === "_form" && r.issues.formErrors.length))); };
  const notSentBody = { resolution: "confirmed_not_sent", evidence: { source: "provider_dashboard", detail: "nada consta" }, justification: "conferi no painel do provedor" };
  const sentBody = { resolution: "confirmed_sent", providerReference: "wamid.HBgM", evidence: { source: "provider_api" }, justification: "GET na API mostrou entregue" };
  const rejBody = { resolution: "confirmed_rejected", evidence: { source: "provider_webhook", detail: "webhook: número inválido" }, justification: "o provedor recusou o envio" };

  const trimmed = v({ ...notSentBody, justification: "  conferi no painel do provedor  " });
  check("V1 not_sent com evidência passa; justificativa aparada", trimmed.ok && trimmed.value.justification === "conferi no painel do provedor");
  check("V2 sent com referência passa", v(sentBody).ok);
  check("V3 sent sem referência: recusado em providerReference", refusedAt({ ...sentBody, providerReference: undefined }, "providerReference"));
  check("V4 referência não é 'consertada': espaço nas pontas recusado", refusedAt({ ...sentBody, providerReference: " wamid.HBgM" }, "providerReference")
    && refusedAt({ ...sentBody, providerReference: "wamid.HBgM\n" }, "providerReference"));
  check("V5 referência vazia, com controle, ou > 256: recusadas",
    refusedAt({ ...sentBody, providerReference: "" }, "providerReference") && refusedAt({ ...sentBody, providerReference: "a\u0007b" }, "providerReference")
    && refusedAt({ ...sentBody, providerReference: "x".repeat(257) }, "providerReference"));
  check("V6 referência de 256 caracteres passa", v({ ...sentBody, providerReference: "x".repeat(256) }).ok);
  check("V7 not_sent COM referência: recusado (não há o que referenciar)", refusedAt({ ...notSentBody, providerReference: "abc" }, "providerReference"));
  check("V8 not_sent sem o que foi consultado: recusado em evidence",
    refusedAt({ ...notSentBody, evidence: { source: "provider_dashboard" } }, "evidence"));
  check("V9 detalhe da evidência: 4 caracteres recusado, 5 passa",
    refusedAt({ ...notSentBody, evidence: { source: "provider_dashboard", detail: "nada" } }, "evidence")
    && v({ ...notSentBody, evidence: { source: "provider_dashboard", detail: "nada." } }).ok);
  check("V10 rejected: sem detalhe recusado; com a referência da recusa passa",
    refusedAt({ ...rejBody, evidence: { source: "provider_webhook" } }, "evidence") && v({ ...rejBody, providerReference: "rej-9" }).ok);
  check("V11 justificativa: 9 recusado, 10 passa, 1000 passa, 1001 recusado",
    refusedAt({ ...notSentBody, justification: "123456789" }, "justification") && v({ ...notSentBody, justification: "1234567890" }).ok
    && v({ ...notSentBody, justification: "j".repeat(1000) }).ok && refusedAt({ ...notSentBody, justification: "j".repeat(1001) }, "justification"));
  check("V12 justificativa que só tem espaços em volta de pouco texto: recusada", refusedAt({ ...notSentBody, justification: "   curto    " }, "justification"));
  check("V13 conta caracteres como o Postgres: 5 emojis (10 unidades UTF-16) recusados, 10 passam",
    refusedAt({ ...notSentBody, justification: "😀".repeat(5) }, "justification") && v({ ...notSentBody, justification: "😀".repeat(10) }).ok);
  check("V14 fonte que não é o provedor, ou evidência ausente: recusadas",
    refusedAt({ ...notSentBody, evidence: { source: "achismo", detail: "acho que não foi" } }, "evidence")
    && refusedAt({ ...notSentBody, evidence: undefined }, "evidence"));
  check("V15 campo extra recusado (status, userId, evidence.token)",
    refusedAt({ ...notSentBody, status: "succeeded" }) && refusedAt({ ...notSentBody, userId: "u-2" })
    && refusedAt({ ...notSentBody, evidence: { ...notSentBody.evidence, token: "EAAG..." } }, "evidence"));
  check("V16 NUL ou surrogate solto na justificativa: recusados",
    refusedAt({ ...notSentBody, justification: "conferi no\u0000 painel" }, "justification")
    && refusedAt({ ...notSentBody, justification: "conferi no painel \uD800" }, "justification"));
  check("V17 decisão fora das três ('failed', 'succeeded'): recusada",
    refusedAt({ ...notSentBody, resolution: "failed" }, "resolution") && refusedAt({ ...sentBody, resolution: "succeeded" }, "resolution"));
  check("V18 corpo que não é objeto: recusado", [null, "x", [], 42].every((b) => !v(b).ok));
  check("V19 decisão -> estado: sent=succeeded, not_sent/rejected=failed",
    statusForResolution("confirmed_sent") === "succeeded" && statusForResolution("confirmed_not_sent") === "failed" && statusForResolution("confirmed_rejected") === "failed");
  const pasted = [
    "Authorization: Bearer abc", "curl -H 'authorization: Basic dXNlcjpwYXNz'", "Cookie: session=abc123",
    '{"Authorization": "Basic dXNlcjpwYXNz"}', '{"cookie": "session=abc123"}',
    "x-api-key: sk_live_4eC39HqLyjWDarjtT1zdp7dc", "https://api.example.com/v1/x?api_key=ab12cd34ef56",
    "access_token=a1b2c3d4e5f6g7h8", "client_secret=abcdef1234567890", "password: hunter2hunter2", "senha: minhaSenha123",
    "sk_live_4eC39HqLyjWDarjtT1zdp7dc", "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB", "xoxb-1234567890-abcdefghij",
    "AKIAIOSFODNN7EXAMPLE",
    "o token era Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0", "-----BEGIN RSA PRIVATE KEY----- MIIE",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "APP_USR-1234567890123456-092118-0123456789abcdef0123456789abcdef-123456789",
    "EAAGm0PX4ZCpsBAKZCZBZAqZCZCkZCZBZAZCZAqZCZCkZCZBZAZCZAqZCZCk", "chave AIzaSyA-1234567890abcdefghijklmnopqrstu",
    "ya29.a0AfH6SMBx1234567890abcdefghij",
  ];
  const leaked = pasted.filter((t) => v({ ...notSentBody, justification: `conferi no painel: ${t}` }).ok
    || v({ ...notSentBody, evidence: { source: "provider_support", detail: t } }).ok);
  check("V21 credencial ou cabeçalho colado (justificativa/evidência): recusado", leaked.length === 0, leaked.join(" | "));
  const plain = [
    "sem autorização do cliente para reenviar; conferi no painel", "a política de cookie do painel não mudou nada",
    "o provedor respondeu 401 e o bearer estava expirado", "pagamento 1234567890 aparece como approved às 14h",
    "mensagem wamid.HBgMNTU5ODk4NzY1NDMyFQIAERgSQ0 entregue",
    "payment 1234567 approved; authorization: 004512", "pending authorization: it was reviewed by the provider",
    "o token de acesso expirou às 14h e o suporte confirmou", "preferência 123456789-abcd1234-ef56-7890 criada",
  ];
  const blocked = plain.filter((t) => !v({ ...notSentBody, justification: t }).ok);
  check("V22 texto comum com 'autorização', 'cookie', 'bearer', ids: aceito", blocked.length === 0, blocked.join(" | "));
  check("V23 referência que é um token: recusada",
    refusedAt({ ...sentBody, providerReference: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N" }, "providerReference")
    && v({ ...sentBody, providerReference: "1234567890" }).ok);
  // o custo da validação é limitado pelo tamanho permitido, não pelo tamanho enviado
  const t0 = performance.now();
  const huge = "eyJ-".repeat(32_768);                                   // 128 KB, o pior caso da revisão
  const r1 = v({ ...notSentBody, justification: huge });
  const r2 = v({ ...notSentBody, evidence: { source: "provider_dashboard", detail: huge } });
  const r3 = v({ ...sentBody, providerReference: huge });
  const ms = performance.now() - t0;
  check("V24 texto enorme recusado pelo tamanho, sem varrer o texto (DoS)", !r1.ok && !r2.ok && !r3.ok && ms < 200
    && r1.issues.fieldErrors.justification?.[0] === "must be at most 1000 characters", `${ms.toFixed(1)} ms`);
  check("V20 contrato: decide owner/admin; resfriamento 600 s; terminais success/error/cancelled",
    RESOLVER_ROLES.join(",") === "owner,admin" && RESOLUTION_COOLING_PERIOD_SECONDS === 600 && TERMINAL_EXECUTION_STATUSES.join(",") === "success,error,cancelled");
}

section("6b. Fase 10.5A — o que /api/effects mostra (effect-view.ts real)");
{
  const began = new Date("2026-09-21T10:00:00.000Z");
  const row = {
    id: "op-1", executionId: "ex-1", workspaceId: "ws-1", nodeId: "send", businessKey: "lead-42", operation: "mock.send_message",
    idempotencyKey: "k".repeat(64), deliveryPolicy: "at_most_once", payloadFingerprint: "f".repeat(64),
    status: "unknown", ownerEpoch: 2, beganEpoch: 1, providerReference: null,
    lastError: { code: "EXTERNAL_EFFECT_UNKNOWN", message: "timed out", stack: "at x (secret.js)" },
    resolvedByUserId: null, resolution: null, createdAt: new Date("2026-09-21T09:59:59.000Z"), updatedAt: began,
  };
  const src = (op, beganAt) => ({ op, executionStatus: "error", workflowId: "wf-1", workflowName: "Lembrete", beganAt });
  const view = toEffectOperationView(src(row, began));
  check("W1 operação: allowlist exata (sem chave idempotente, sem fingerprint)",
    Object.keys(view).sort().join(",") === "beganAt,businessKey,createdAt,executionId,executionStatus,lastError,nodeId,operation,operationId,outcomeKnown,providerReference,resolution,resolvableFrom,resolvedByUserId,status,updatedAt,workflowId,workflowName"
    && !JSON.stringify(view).includes("k".repeat(64)) && !JSON.stringify(view).includes("f".repeat(64)), Object.keys(view).length + " campos");
  check("W2 lastError só com code/message (nada além)", JSON.stringify(view.lastError) === '{"code":"EXTERNAL_EFFECT_UNKNOWN","message":"timed out"}');
  const fromString = toEffectOperationView(src(row, "2026-09-21 10:00:00+00"));
  check("W3 beganAt: aceita a string crua do driver, e Date", fromString.beganAt === began.toISOString() && view.beganAt === began.toISOString());
  check("W4 beganAt inválido vira null (não 'Invalid Date')", toEffectOperationView(src(row, "não é data")).beganAt === null);
  check("W5 resolvableFrom = began + 600 s, só para unknown",
    view.resolvableFrom === new Date(began.getTime() + 600_000).toISOString()
    && toEffectOperationView(src({ ...row, status: "failed", resolvedByUserId: "u", resolution: "confirmed_not_sent" }, began)).resolvableFrom === null);
  check("W6 sem 'began' no histórico: conta da criação (como o repositório)",
    toEffectOperationView(src(row, null)).resolvableFrom === new Date(row.createdAt.getTime() + 600_000).toISOString());
  check("W7 lastError malformado vira null", toEffectOperationView(src({ ...row, lastError: { code: 1 } }, began)).lastError === null);
  const fact = {
    seq: 7, event: "resolved", actor: "user", epoch: null, actorUserId: "u-1", fromStatus: "unknown", toStatus: "failed",
    applied: true, providerReference: null, createdAt: began,
    detail: { resolution: "confirmed_not_sent", justification: "conferi no painel do provedor",
      evidence: { source: "provider_dashboard", detail: "nada consta", token: "EAAG-SECRET" },
      payload: { phone: "+5598..." }, authorization: "Bearer x" },
  };
  const hv = toEffectAttemptView(fact);
  check("W8 histórico: só chaves conhecidas; evidence só source/detail",
    JSON.stringify(hv.detail) === JSON.stringify({ resolution: "confirmed_not_sent", evidence: { source: "provider_dashboard", detail: "nada consta" }, justification: "conferi no painel do provedor" })
    && !/EAAG|Bearer|5598/.test(JSON.stringify(hv)), JSON.stringify(hv.detail));
  const wv = toEffectAttemptView({ ...fact, event: "began", actor: "worker", epoch: 1, actorUserId: null, detail: null });
  check("W9 época aparece como 'attempt'; data em ISO; detail nulo vira {}", wv.attempt === 1 && wv.at === began.toISOString() && JSON.stringify(wv.detail) === "{}" && !("epoch" in wv));
}

section("6c. Fase 10.5A — resolver: ordem das recusas, prova, e o fato do provedor por cima");
{
  memdb.reset();
  let now = Date.now(); memdb.clock = () => new Date(now);
  const p = new MockExternalEffect();
  const a = fresh("z1");
  await a.runner.run("send", spec(p, "timeout"));
  const [op] = opsFor("z1");
  const r1 = await resolveUnknown(op.id, "u-1", notSent());
  check("M1 execução viva: execution_active (antes de olhar o relógio)", r1.outcome === "execution_active" && r1.executionStatus === "running");
  finish("z1", a.epoch, "error");
  const beganAt = eventsFor(op.id).find((e) => e.event === "began").createdAt;
  const r2 = await resolveUnknown(op.id, "u-1", notSent());
  check("M2 resfriamento padrão (600 s, relógio do BANCO): too_early com a hora certa",
    r2.outcome === "too_early" && r2.resolvableFrom.getTime() === beganAt.getTime() + 600_000);
  now += 599_000;
  check("M3 599 s depois: ainda cedo", (await resolveUnknown(op.id, "u-1", notSent())).outcome === "too_early");
  check("M4 ...recusas não deixam rastro", opsFor("z1")[0].status === "unknown" && evs(op.id) === "reserved@1 began@1 unknown@1");
  now += 1_000;
  const r3 = await resolveUnknown(op.id, "u-1", notSent());
  const fact = eventsFor(op.id).at(-1);
  check("M5 600 s depois: resolved -> failed, com quem e o quê",
    r3.outcome === "resolved" && r3.operation.status === "failed" && r3.operation.resolution === "confirmed_not_sent"
    && r3.operation.resolvedByUserId === "u-1" && r3.operation.lastError.code === "RESOLVED_NOT_SENT");
  check("M6 UM fato resolved, com decisão, evidência e justificativa",
    fact.event === "resolved" && fact.actor === "user" && fact.epoch === null
    && JSON.stringify(fact.detail) === JSON.stringify({ resolution: "confirmed_not_sent", evidence: { source: "provider_dashboard", detail: "nenhuma mensagem para lead-42" }, justification: "não achei no painel do provedor" }));
  const r4 = await resolveUnknown(op.id, "u-2", sent("x-1"), NOW);
  check("M7 segunda pessoa: not_unknown (ninguém sobrescreve ninguém)", r4.outcome === "not_unknown" && r4.status === "failed");
  let g = ""; try { rawUpdate(op.id, { resolvedByUserId: "u-2", resolution: "confirmed_rejected", lastError: { code: "RESOLVED_REJECTED", message: "x" } }); } catch (e) { g = e.message; }
  check("M8 escrita direta pessoa-sobre-pessoa: o guard recusa", /^guard:/.test(g), g);
  let g2 = ""; try { rawUpdate(op.id, { resolution: "confirmed_rejected", lastError: { code: "RESOLVED_REJECTED", message: "x" } }); } catch (e) { g2 = e.message; }
  check("M9 nem a mesma pessoa troca a decisão", /^guard:/.test(g2), g2);

  // um pedido que NÃO passou pelo validador: o espelho do CHECK recusa, e nada muda
  const b = fresh("z2"); await b.runner.run("send", spec(p, "timeout")); finish("z2", b.epoch, "error");
  const [op2] = opsFor("z2");
  let c = ""; try { await resolveUnknown(op2.id, "u-1", { resolution: "confirmed_not_sent", evidence: { source: "provider_dashboard" }, justification: "curta" }, NOW); } catch (e) { c = e.message; }
  check("M10 fato resolved sem evidência: CHECK recusa, e o estado não muda (uma transação)",
    c === "check: resolution_has_evidence" && opsFor("z2")[0].status === "unknown" && !eventsFor(op2.id).some((e) => e.event === "resolved"), c);
  let c2 = ""; try { rawUpdate(op2.id, { resolution: "confirmed_sent" }); } catch (e) { c2 = e.message; }
  check("M11 resolution sem resolved_by_user_id: CHECK recusa", c2 === "check: resolution_matches", c2);
  let c3 = ""; try { rawUpdate(op2.id, { status: "failed", resolvedByUserId: "u-9", resolution: "confirmed_not_sent",
    lastError: { code: "RESOLVED_NOT_SENT", message: "x" } }); } catch (e) { c3 = e.message; }
  check("M20 escrita direta de resolução, sem o fato: recusada (espelho do trigger da 0007)",
    c3 === "trigger: resolution_is_recorded" && opsFor("z2")[0].status === "unknown", c3);
  const r5 = await resolveUnknown(op2.id, "u-1", validateResolveEffectRequest({ ...{ resolution: "confirmed_rejected", providerReference: "rej-9",
    evidence: { source: "provider_webhook", detail: "webhook: número inválido" }, justification: "o provedor recusou o envio" } }), NOW);
  check("M12 rejected: failed, referência da recusa só no fato",
    r5.outcome === "resolved" && r5.operation.status === "failed" && r5.operation.providerReference === null
    && r5.operation.lastError.code === "RESOLVED_REJECTED" && eventsFor(op2.id).at(-1).providerReference === "rej-9");

  // o fato do provedor por cima da decisão
  const d = fresh("z3"); void d.runner.run("send", spec(p, "crash_after_request")); await settle();   // in_flight; a chamada "aconteceu" e o processo morreu
  finish("z3", d.epoch, "error");                                                       // o trigger: unknown@system
  const [op3] = opsFor("z3");
  await resolveUnknown(op3.id, "u-1", sent("prov-palpite"), NOW);
  await recordEffectOutcome({ operationId: op3.id, executionId: "z3", epoch: d.epoch, outcome: { kind: "failed", code: "PROVIDER_REJECTED", message: "número inválido" } });
  const o3 = opsFor("z3")[0]; const f3 = eventsFor(op3.id).at(-1);
  check("M13 provedor contradiz (sent -> failed): o fato substitui e zera a decisão",
    o3.status === "failed" && o3.providerReference === null && o3.resolution === null && o3.resolvedByUserId === null && o3.lastError.code === "PROVIDER_REJECTED");
  check("M14 ...e nomeia o juízo que substituiu", f3.applied && f3.detail.overridesResolution?.resolution === "confirmed_sent"
    && f3.detail.overridesResolution?.status === "succeeded" && f3.detail.overridesResolution?.resolvedByUserId === "u-1", JSON.stringify(f3.detail.overridesResolution));
  check("M15 histórico com as três vozes", evs(op3.id) === "reserved@1 began@1 unknown@system resolved@user failed@1", evs(op3.id));

  const e4 = fresh("z4"); void e4.runner.run("send", spec(p, "crash_after_request")); await settle(); finish("z4", e4.epoch, "error");
  const [op4] = opsFor("z4");
  await resolveUnknown(op4.id, "u-1", sent("prov-4"), NOW);
  await recordEffectOutcome({ operationId: op4.id, executionId: "z4", epoch: e4.epoch, outcome: { kind: "succeeded", providerReference: "prov-4" } });
  const o4 = opsFor("z4")[0];
  check("M16 provedor CONCORDA: vira a palavra do provedor (resolution zerada)", o4.status === "succeeded" && o4.providerReference === "prov-4" && o4.resolution === null && o4.resolvedByUserId === null);

  const e5 = fresh("z5"); void e5.runner.run("send", spec(p, "crash_after_request")); await settle(); finish("z5", e5.epoch, "error");
  const [op5] = opsFor("z5");
  await resolveUnknown(op5.id, "u-1", notSent(), NOW);
  await recordEffectOutcome({ operationId: op5.id, executionId: "z5", epoch: e5.epoch, outcome: { kind: "unknown", reason: "deadline" } });
  await recordEffectOutcome({ operationId: op5.id, executionId: "z5", epoch: e5.epoch + 1, outcome: { kind: "succeeded", providerReference: "forjado" } });
  const o5 = opsFor("z5")[0];
  check("M17 'unknown' tardio e fato de época que não fez a chamada: não desfazem a decisão",
    o5.status === "failed" && o5.resolution === "confirmed_not_sent" && evs(op5.id) === "reserved@1 began@1 unknown@system resolved@user unknown@1(não aplicado) succeeded@2(não aplicado)", evs(op5.id));

  const e6 = fresh("z6");
  memdb.faults.beforeBegin = async () => "crash";
  void e6.runner.run("send", spec(p, "success")); await settle();              // reservou e morreu antes do begin
  memdb.faults.beforeBegin = null;
  finish("z6", e6.epoch, "error");
  const [op6] = opsFor("z6");
  const r6 = await resolveUnknown(op6.id, "u-1", notSent(), NOW);
  check("M18 reserved (nunca cruzou o ponto sem volta): não se resolve", op6.status === "reserved" && r6.outcome === "not_unknown" && r6.status === "reserved");
  check("M19 operação inexistente: not_found", (await resolveUnknown("op-nao-existe", "u-1", notSent(), NOW)).outcome === "not_found");
  memdb.reset();
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
