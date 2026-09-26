// Fase 10.5A — scripts/effects-spec/routes/run.sh. As ROTAS reais (compiladas), com Next/auth/repositórios
// trocados por stubs roteirizados. O que está sob teste: a tradução para
// HTTP — status, código, corpo — e o que a rota repassa (ou não) adiante.
import { NextRequest } from "./out/stubs/next-server.js";
import { session } from "./out/lib/auth/session.js";
import * as effRepo from "./out/server/execution/effects/effect-repository.js";
import * as wfMut from "./out/server/workflows/mutations.js";
import * as wfQ from "./out/server/workflows/queries.js";
import { WorkflowConflictError, WORKFLOW_CONFLICT_MESSAGES } from "./out/server/workflows/errors.js";
import { GET as listEffects } from "./out/app/api/effects/route.js";
import { GET as effectDetail } from "./out/app/api/effects/[operationId]/route.js";
import { POST as resolveEffect } from "./out/app/api/effects/[operationId]/resolve/route.js";
import { POST as archiveRoute } from "./out/app/api/workflows/[id]/archive/route.js";
import { POST as restoreRoute } from "./out/app/api/workflows/[id]/restore/route.js";
import { PATCH as patchWorkflow, DELETE as deleteWorkflowRoute } from "./out/app/api/workflows/[id]/route.js";
import { GET as listWorkflowsRoute } from "./out/app/api/workflows/route.js";
import { POST as executeRoute } from "./out/app/api/workflows/[id]/execute/route.js";
import * as execSvc from "./out/server/execution/execute-workflow.js";
import * as enqueueSvc from "./out/server/execution/enqueue-workflow-execution.js";
import { ExecutionEngineError, ExecutionErrorCode } from "./out/lib/execution/errors.js";
import { QueueError } from "./out/server/execution/execution-queue.js";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label.padEnd(70)}${detail}`); }
  else { fail++; console.log(`FAIL  ${label.padEnd(70)}${detail}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const req = (path, body) => new NextRequest(`http://localhost${path}`, { method: "POST", body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const call = async (handler, request, params) => { const r = await handler(request, params ? { params } : undefined); return { status: r.status, body: await r.json() }; };
const login = () => { session.user = { id: "user-1", email: "a@b.c" }; };
const reset = () => { effRepo.calls.length = 0; wfMut.calls.length = 0; wfQ.calls.length = 0; };
const OP = "6f0c9a52-1d7b-4b0e-9a8e-3c1f2b4d5e6a";
const WF = "0b7c1e2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d";
const began = new Date("2026-09-21T10:00:00.000Z");
const opRow = {
  id: OP, executionId: "ex-1", workspaceId: "ws-of-user-1", nodeId: "send", businessKey: "lead-42", operation: "mock.send_message",
  idempotencyKey: "k".repeat(64), payloadFingerprint: "f".repeat(64), status: "unknown", ownerEpoch: 1, beganEpoch: 1,
  providerReference: null, lastError: { code: "EXTERNAL_EFFECT_UNKNOWN", message: "timed out" }, resolvedByUserId: null, resolution: null,
  createdAt: began, updatedAt: began,
};
const source = { op: opRow, executionStatus: "error", workflowId: "wf-1", workflowName: "Lembrete", beganAt: began };
const validBody = { resolution: "confirmed_not_sent", evidence: { source: "provider_dashboard", detail: "nada consta" }, justification: "  conferi no painel do provedor  " };

section("GET /api/effects");
{
  session.user = null; reset();
  let r = await call(listEffects, req("/api/effects"));
  check("R1 sem sessão: 401, e o repositório nem é chamado", r.status === 401 && effRepo.calls.length === 0);
  login(); reset(); effRepo.script.list = async () => [source];
  r = await call(listEffects, req("/api/effects"));
  const c = effRepo.calls[0];
  check("R2 padrão: só os unknown, do workspace da SESSÃO", r.status === 200 && c.args[0] === "user-1" && c.args[1] === "ws-of-user-1"
    && c.args[2].status === "unknown" && c.args[2].limit === undefined, JSON.stringify(c.args[2]));
  check("R3 corpo é a view (sem chave idempotente, sem fingerprint)", r.body.operations.length === 1 && r.body.operations[0].operationId === OP
    && !JSON.stringify(r.body).includes("k".repeat(64)) && !JSON.stringify(r.body).includes("f".repeat(64)));
  reset(); r = await call(listEffects, req("/api/effects?status=all&limit=200"));
  check("R4 status=all -> sem filtro; limit=200 aceito", r.status === 200 && effRepo.calls[0].args[2].status === undefined && effRepo.calls[0].args[2].limit === 200);
  reset();
  const bad = [];
  for (const q of ["status=bogus", "limit=0", "limit=201", "limit=abc", "limit=1.5", "limit="]) {
    const x = await call(listEffects, req(`/api/effects?${q}`)); if (x.status !== 400 || x.body.error.code !== "VALIDATION_ERROR") bad.push(q);
  }
  check("R5 status/limit inválidos: 400 VALIDATION_ERROR, repositório intocado", bad.length === 0 && effRepo.calls.length === 0, bad.join(","));
  effRepo.script.list = async () => { throw new Error("connection string postgres://user:SECRET@db"); };
  r = await call(listEffects, req("/api/effects"));
  check("R6 falha do banco: 500 genérico, sem vazar a mensagem", r.status === 500 && r.body.error.code === "EFFECTS_LIST_FAILED" && !JSON.stringify(r.body).includes("SECRET"));
}

section("GET /api/effects/[operationId]");
{
  login(); reset();
  let r = await call(effectDetail, req("/api/effects/x"), { operationId: "../../etc" });
  check("R7 id que não é UUID: 404 sem consultar nada", r.status === 404 && r.body.error.code === "EFFECT_NOT_FOUND" && effRepo.calls.length === 0);
  effRepo.script.detail = async () => null;
  r = await call(effectDetail, req("/api/effects/x"), { operationId: OP });
  check("R8 não encontrado (ou de outro workspace): 404", r.status === 404 && effRepo.calls[0].args[1] === "ws-of-user-1");
  effRepo.script.detail = async () => ({ ...source, attempts: [
    { seq: 1, event: "began", actor: "worker", epoch: 1, actorUserId: null, fromStatus: "reserved", toStatus: "in_flight", applied: true,
      providerReference: null, detail: { payload: { phone: "+55 98 9..." } }, createdAt: began } ] });
  r = await call(effectDetail, req("/api/effects/x"), { operationId: OP });
  check("R9 encontrado: {operation, history}; detail fora da allowlist some", r.status === 200 && r.body.operation.operationId === OP
    && r.body.history.length === 1 && r.body.history[0].attempt === 1 && JSON.stringify(r.body.history[0].detail) === "{}");
  effRepo.script.detail = async () => { throw new Error("FORBIDDEN: user is not a member of this workspace"); };
  r = await call(effectDetail, req("/api/effects/x"), { operationId: OP });
  check("R10 FORBIDDEN vira 404 (indistinguível de inexistente)", r.status === 404 && !JSON.stringify(r.body).includes("member"));
}

section("POST /api/effects/[operationId]/resolve");
{
  session.user = null; reset();
  let r = await call(resolveEffect, req("/r", validBody), { operationId: OP });
  check("R11 sem sessão: 401", r.status === 401 && effRepo.calls.length === 0);
  login(); reset();
  r = await call(resolveEffect, req("/r", validBody), { operationId: "not-a-uuid" });
  check("R12 id que não é UUID: 404", r.status === 404 && effRepo.calls.length === 0);
  r = await call(resolveEffect, req("/r", JSON.stringify({ ...validBody, justification: "x".repeat(20_000) })), { operationId: OP });
  check("R12b corpo muito maior que qualquer resolução: 413 antes de interpretar", r.status === 413 && r.body.error.code === "PAYLOAD_TOO_LARGE" && effRepo.calls.length === 0);
  r = await call(resolveEffect, req("/r", "{not json"), { operationId: OP });
  check("R13 JSON inválido: 400 INVALID_JSON", r.status === 400 && r.body.error.code === "INVALID_JSON");
  r = await call(resolveEffect, req("/r", { ...validBody, justification: undefined }), { operationId: OP });
  check("R14 sem justificativa: 400, e a mensagem diz o campo", r.status === 400 && r.body.error.code === "VALIDATION_ERROR" && /^justification: /.test(r.body.error.message), r.body.error.message);
  r = await call(resolveEffect, req("/r", { resolution: "confirmed_sent", evidence: { source: "provider_api" }, justification: "a API mostrou entregue" }), { operationId: OP });
  check("R15 confirmed_sent sem referência: 400 providerReference", r.status === 400 && /^providerReference: /.test(r.body.error.message), r.body.error.message);
  r = await call(resolveEffect, req("/r", { ...validBody, evidence: { source: "provider_dashboard" } }), { operationId: OP });
  check("R16 not_sent sem o que foi consultado: 400 evidence", r.status === 400 && /^evidence: /.test(r.body.error.message), r.body.error.message);
  r = await call(resolveEffect, req("/r", { ...validBody, workspaceId: "ws-alheio", userId: "outro" }), { operationId: OP });
  check("R17 workspaceId/userId no corpo: recusados (400), nunca repassados", r.status === 400 && effRepo.calls.length === 0);
  const cases = [
    [{ outcome: "forbidden" }, 403, "EFFECT_RESOLUTION_FORBIDDEN"],
    [{ outcome: "not_found" }, 404, "EFFECT_NOT_FOUND"],
    [{ outcome: "not_unknown", status: "succeeded" }, 409, "EFFECT_NOT_UNKNOWN"],
    [{ outcome: "execution_active", executionStatus: "running" }, 409, "EFFECT_EXECUTION_ACTIVE"],
    [{ outcome: "too_early", resolvableFrom: new Date("2026-09-21T10:10:00.000Z") }, 409, "EFFECT_RESOLUTION_TOO_EARLY"],
  ];
  const wrong = [];
  for (const [result, status, code] of cases) {
    effRepo.script.resolve = async () => result;
    const x = await call(resolveEffect, req("/r", validBody), { operationId: OP });
    if (x.status !== status || x.body.error.code !== code) wrong.push(`${result.outcome}->${x.status}/${x.body.error?.code}`);
  }
  check("R18 cada recusa com seu status e código (403/404/409x3)", wrong.length === 0, wrong.join(" "));
  effRepo.script.resolve = async () => ({ outcome: "too_early", resolvableFrom: new Date("2026-09-21T10:10:00.000Z") });
  r = await call(resolveEffect, req("/r", validBody), { operationId: OP });
  check("R19 too_early diz a partir de quando", r.body.error.message.includes("2026-09-21T10:10:00.000Z"));
  reset();
  effRepo.script.resolve = async () => ({ outcome: "resolved", operation: {} });
  effRepo.script.detail = async () => ({ ...source, op: { ...opRow, status: "failed", resolution: "confirmed_not_sent", resolvedByUserId: "user-1",
    lastError: { code: "RESOLVED_NOT_SENT", message: "conferi no painel do provedor" } }, attempts: [] });
  r = await call(resolveEffect, req("/r", validBody), { operationId: OP });
  const rc = effRepo.calls.find((c) => c.fn === "resolve");
  check("R20 resolved: 200 {operation} pela view", r.status === 200 && r.body.operation.status === "failed" && r.body.operation.resolution === "confirmed_not_sent"
    && !("idempotencyKey" in r.body.operation));
  check("R21 repassa usuário e workspace da SESSÃO, entrada validada (aparada)",
    rc.args[0] === "user-1" && rc.args[1] === "ws-of-user-1" && rc.args[2] === OP && rc.args[3].justification === "conferi no painel do provedor");
  check("R22 e NÃO dispensa o resfriamento (sem options)", rc.args.length === 4, `args=${rc.args.length}`);
  effRepo.script.resolve = async () => { throw new Error("deadlock detected on relation effect_operations"); };
  r = await call(resolveEffect, req("/r", validBody), { operationId: OP });
  check("R23 falha do banco: 500 genérico, sem vazar", r.status === 500 && r.body.error.code === "EFFECT_RESOLUTION_FAILED" && !JSON.stringify(r.body).includes("deadlock"));
}

section("arquivar / restaurar / apagar / editar / listar workflows");
{
  login(); reset();
  let r = await call(archiveRoute, req("/a"), { id: "../x" });
  const rr = await call(restoreRoute, req("/r"), { id: "not-a-uuid" });
  check("R23b arquivar/restaurar com id que não é UUID: 404, sem tocar no banco", r.status === 404 && rr.status === 404 && wfMut.calls.length === 0);
  wfMut.script.archive = async () => ({ outcome: "not_found" });
  r = await call(archiveRoute, req("/a"), { id: WF });
  check("R24 arquivar inexistente: 404", r.status === 404 && r.body.error.code === "WORKFLOW_NOT_FOUND" && wfMut.calls[0].args[1] === "ws-of-user-1");
  wfMut.script.archive = async () => ({ outcome: "archived", workflow: { id: "wf-1", archivedAt: began } });
  r = await call(archiveRoute, req("/a"), { id: WF });
  const r2 = (wfMut.script.archive = async () => ({ outcome: "already_archived", workflow: { id: WF } }), await call(archiveRoute, req("/a"), { id: WF }));
  check("R25 arquivar: 200 {workflow}; de novo: 200 (idempotente)", r.status === 200 && r.body.workflow.id === "wf-1" && r2.status === 200);
  wfMut.script.archive = async () => { throw new WorkflowConflictError("WORKFLOW_HAS_ACTIVE_EXECUTIONS", WORKFLOW_CONFLICT_MESSAGES.WORKFLOW_HAS_ACTIVE_EXECUTIONS); };
  r = await call(archiveRoute, req("/a"), { id: WF });
  check("R26 execução viva: 409 WORKFLOW_HAS_ACTIVE_EXECUTIONS", r.status === 409 && r.body.error.code === "WORKFLOW_HAS_ACTIVE_EXECUTIONS");
  wfMut.script.archive = async () => { throw new Error("pool exhausted: postgres://SECRET"); };
  r = await call(archiveRoute, req("/a"), { id: WF });
  check("R27 falha inesperada: 500 genérico", r.status === 500 && !JSON.stringify(r.body).includes("SECRET"));
  wfMut.script.restore = async () => ({ outcome: "restored", workflow: { id: "wf-1", archivedAt: null } });
  r = await call(restoreRoute, req("/r"), { id: WF });
  wfMut.script.restore = async () => ({ outcome: "not_found" });
  const r3 = await call(restoreRoute, req("/r"), { id: WF });
  check("R28 restaurar: 200; inexistente: 404", r.status === 200 && r.body.workflow.archivedAt === null && r3.status === 404);
  wfMut.script.remove = async () => { throw new WorkflowConflictError("WORKFLOW_HAS_EFFECT_HISTORY", WORKFLOW_CONFLICT_MESSAGES.WORKFLOW_HAS_EFFECT_HISTORY); };
  r = await call(deleteWorkflowRoute, req("/d"), { id: WF });
  check("R29 apagar com histórico de efeito: 409 e diz 'archive'", r.status === 409 && r.body.error.code === "WORKFLOW_HAS_EFFECT_HISTORY" && /Archive/.test(r.body.error.message));
  wfMut.script.remove = async () => ({ id: WF });
  r = await call(deleteWorkflowRoute, req("/d"), { id: WF });
  const r4 = (wfMut.script.remove = async () => null, await call(deleteWorkflowRoute, req("/d"), { id: WF }));
  check("R30 apagar sem histórico: 200; inexistente: 404 (como antes)", r.status === 200 && r.body.success === true && r4.status === 404);
  wfMut.script.update = async () => { throw new WorkflowConflictError("WORKFLOW_ARCHIVED", WORKFLOW_CONFLICT_MESSAGES.WORKFLOW_ARCHIVED); };
  r = await call(patchWorkflow, req("/p", { name: "x" }), { id: WF });
  check("R31 editar arquivado: 409 WORKFLOW_ARCHIVED", r.status === 409 && r.body.error.code === "WORKFLOW_ARCHIVED");
  reset();
  await call(listWorkflowsRoute, new NextRequest("http://localhost/api/workflows"));
  await call(listWorkflowsRoute, new NextRequest("http://localhost/api/workflows?archived=true"));
  check("R32 lista: ativos por padrão; ?archived=true só os arquivados",
    JSON.stringify(wfQ.calls.map((c) => c.args[2])) === JSON.stringify([{ archived: false }, { archived: true }]));
}

section("POST /api/workflows/[id]/execute (o mesmo segmento [id] das outras)");
{
  login();
  execSvc.calls.length = 0; enqueueSvc.calls.length = 0;
  const archived = () => new ExecutionEngineError(ExecutionErrorCode.WORKFLOW_ARCHIVED, "This workflow is archived. Restore it before executing it.");
  execSvc.script.execute = async () => { throw archived(); };
  enqueueSvc.script.enqueue = async () => { throw archived(); };
  const sync = await call(executeRoute, req("/e", {}), { id: WF });
  const async_ = await call(executeRoute, req("/e", { mode: "async" }), { id: WF });
  check("R33 executar workflow arquivado: 409 WORKFLOW_ARCHIVED nos dois caminhos",
    sync.status === 409 && sync.body.error.code === "WORKFLOW_ARCHIVED" && /Restore it/.test(sync.body.error.message)
    && async_.status === 409 && async_.body.error.code === "WORKFLOW_ARCHIVED");
  check("R34 ...e o workspace é o da sessão, com o id do caminho",
    execSvc.calls[0].args[0].workspaceId === "ws-of-user-1" && execSvc.calls[0].args[0].workflowId === WF
    && enqueueSvc.calls[0].args[0].workspaceId === "ws-of-user-1");
  execSvc.script.execute = async () => { throw new ExecutionEngineError(ExecutionErrorCode.WORKFLOW_NOT_FOUND, "This workflow could not be found"); };
  let r = await call(executeRoute, req("/e", { workspaceId: "ws-alheio" }), { id: WF });
  check("R35 inexistente: 404; workspaceId no corpo é ignorado",
    r.status === 404 && r.body.error.code === "WORKFLOW_NOT_FOUND" && execSvc.calls.at(-1).args[0].workspaceId === "ws-of-user-1");
  execSvc.script.execute = async () => ({ executionId: "ex-1", status: "error", error: { code: "EXTERNAL_EFFECT_UNKNOWN", message: "unknown", nodeId: "send" } });
  r = await call(executeRoute, req("/e", {}), { id: WF });
  check("R36 execução que termina em erro ainda é 200 (o resultado está no corpo)",
    r.status === 200 && r.body.status === "error" && r.body.error.code === "EXTERNAL_EFFECT_UNKNOWN");
  enqueueSvc.script.enqueue = async () => ({ executionId: "ex-2", status: "queued" });
  r = await call(executeRoute, req("/e", { mode: "async" }), { id: WF });
  check("R37 async: 202 { executionId, status: queued }", r.status === 202 && r.body.status === "queued");
  enqueueSvc.script.enqueue = async () => { throw new QueueError("EXECUTION_NOT_QUEUEABLE", "not queueable"); };
  r = await call(executeRoute, req("/e", { mode: "async" }), { id: WF });
  check("R38 fila inconsistente: 500 com o código, sem detalhe interno", r.status === 500 && r.body.error.code === "EXECUTION_NOT_QUEUEABLE");
  r = await call(executeRoute, req("/e", { mode: "outro" }), { id: WF });
  check("R39 mode desconhecido: 400 VALIDATION_ERROR (validação real)", r.status === 400 && r.body.error.code === "VALIDATION_ERROR");
  session.user = null;
  r = await call(executeRoute, req("/e", {}), { id: WF });
  check("R40 sem sessão: 401", r.status === 401);
  login();
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
