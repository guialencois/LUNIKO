import { db } from "@/lib/db";
import { executions, executionNodes } from "@/lib/db/schema";
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { requireWorkspaceMembership } from "@/lib/auth/session";
import { redactWorkflowDocument } from "@/lib/workflows/redaction";
import { EXECUTION_LIMITS } from "@/lib/execution/types";
import type {
  ExecutionStatus,
  ExecutionError,
  NodeExecutionResult,
  NodeOutput,
} from "@/lib/execution/types";

/**
 * Two authorization models, per docs/async-execution.md ("Autorização —
 * DECIDIDO: dois modelos distintos"):
 *
 * MODELO 1 — pedido de um usuário vivo (API): every function below in this
 * group takes (userId, workspaceId, ...) and calls
 * requireWorkspaceMembership before touching the database — same pattern
 * as server/workflows/queries.ts. Used for anything a live, authenticated
 * HTTP request initiates or reads: createExecution, finishExecution,
 * insertExecutionNodes, getExecutionById, createQueuedExecution.
 *
 * MODELO 2 — trabalho já autorizado, concluído por um processo interno
 * (o worker, not built yet — this file only adds what it will need):
 * these functions take ONLY an executionId, never userId/workspaceId, and
 * never call requireWorkspaceMembership. Authorization already happened
 * once, at enqueue time (MODELO 1, createQueuedExecution) — the
 * executionId itself is the only credential a worker has or needs, and
 * every value it operates on (workspaceId, document) is read back from the
 * execution row itself, never trusted from a queue payload. Functions:
 * claimQueuedExecution, reclaimExpiredExecution,
 * findStaleRunningExecutionIds, abandonExecution, finishQueuedExecution,
 * insertExecutionNodesInternal.
 *
 * Neither model is new permissions — MODELO 2 simply doesn't ask a
 * question (live membership) that doesn't apply to a process acting on
 * previously-authorized work.
 */

/**
 * NOTE ON REDACTION — why nothing here rewrites what it stores.
 *
 * This file used to pass everything it persisted (document, result, node
 * output, error) through a redaction helper that replaced the value of
 * any property whose NAME matched
 * /token|password|secret|key|authorization|cookie|credential/i, at any
 * depth. That was removed, because applied to a workflow document it was
 * not a safety measure but a correctness bug: a Set node keeps
 * `data.values` as a record whose keys the user types into the editor, so
 * a field named "bookingKey" was stored as "[REDACTED]" — and since the
 * asynchronous path EXECUTES the stored row (process-queued-execution.ts
 * reads claimed.document), the worker then ran a document that was not
 * the one the user authored. The synchronous path plans from
 * workflow.document in memory, so it produced the right result off a
 * corrupted snapshot: same workflow, two different behaviours.
 *
 * The rule now:
 *   - what this file STORES is the runtime truth, kept intact — the
 *     document above all, because something later executes it;
 *   - redaction happens on the way OUT, in the read path meant for a
 *     human (getExecutionById), via lib/workflows/redaction.ts, and is
 *     targeted at the one namespace where a credential is actually
 *     authored today (an httpRequest node's HTTP headers) rather than
 *     guessed from arbitrary field names.
 *
 * Nothing in the project writes a real credential into an execution row
 * today (httpRequest and code are NOT_IMPLEMENTED, so no node reaches a
 * network or holds a token). When a credentials system exists, encryption
 * at rest and an explicit redaction of THAT structure are what protect it
 * — not a regex over user data.
 */

// ---- MODELO 1 (usuário vivo) ----------------------------------------------

/**
 * Used by the existing synchronous path (server/execution/execute-workflow.ts)
 * — unchanged. Inserts directly as "running" because that path has no
 * queue/worker step between creation and execution. Kept exactly as it was
 * so the synchronous engine keeps working without modification.
 */
export async function createExecution(
  userId: string,
  workspaceId: string,
  workflowId: string,
  document: unknown
) {
  await requireWorkspaceMembership(userId, workspaceId);

  const [execution] = await db
    .insert(executions)
    .values({
      workflowId,
      workspaceId,
      status: "running",
      document,
      triggerType: "manual",
      // Este lifecycle vive inteiro dentro de uma request HTTP: nunca é
      // enfileirado, nunca é reclamado, e o reaper nunca o enxerga.
      runner: "request",
      startedAt: new Date(),
      createdBy: userId,
    })
    .returning();

  // Um INSERT de uma linha com RETURNING devolve exatamente uma linha: ou
  // insere e devolve, ou lança. Zero linhas aqui é falha de infraestrutura e
  // tem de aparecer com esse nome, em vez de propagar `undefined`.
  //
  // Isto NÃO é o mesmo caso das funções de UPDATE deste arquivo, que
  // devolvem `?? null` de propósito: lá o WHERE pode legitimamente não casar
  // (é o guard de cerca), e "nenhuma linha" é uma resposta, não um defeito.
  if (!execution) {
    throw new Error("createExecution: o INSERT em executions não devolveu a linha criada");
  }

  return execution;
}

export async function finishExecution(
  userId: string,
  workspaceId: string,
  executionId: string,
  input: { status: ExecutionStatus; durationMs: number; error?: ExecutionError }
) {
  await requireWorkspaceMembership(userId, workspaceId);

  const [execution] = await db
    .update(executions)
    .set({
      status: input.status,
      finishedAt: new Date(),
      durationMs: input.durationMs,
      error: input.error ?? null,
    })
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.workspaceId, workspaceId),
        // Fase 4G — duas barreiras que faltavam aqui:
        //
        //   runner = 'request'  este finish pertence ao caminho síncrono.
        //     Sem isso, uma request tardia podia escrever por cima de uma
        //     execução de worker — inclusive por cima de um WORKER_CRASHED
        //     que o reaper já tinha decidido. O espelho exato do bug que o
        //     fencing corrigiu do lado assíncrono.
        //
        //   status = 'running'  estado terminal é final. Uma execução já
        //     concluída (ou recuperada) não é reaberta por uma chamada
        //     atrasada, duplicada ou repetida.
        eq(executions.runner, "request"),
        eq(executions.status, "running")
      )
    )
    .returning();

  return execution ?? null;
}

/**
 * Shared row-mapping for execution_nodes — used by both the MODELO 1 write
 * (insertExecutionNodes, live user path) and the MODELO 2 write
 * (insertExecutionNodesInternal, worker path) below, so the two never
 * silently diverge on what gets persisted per node.
 */
function buildExecutionNodeRows(
  executionId: string,
  nodeResults: ReadonlyMap<
    string,
    NodeExecutionResult & { nodeType: string; startedAt: Date; finishedAt: Date }
  >
) {
  return Array.from(nodeResults.entries()).map(([nodeId, result]) => ({
    executionId,
    nodeId,
    nodeType: result.nodeType,
    status: result.status,
    // input intentionally not persisted per node: it's fully reconstructable
    // from the upstream nodes' own persisted outputs (that's how the engine
    // computed it in the first place), so storing it again would just
    // double the redaction surface for no new information. Revisit if a
    // future debugging need justifies the extra storage.
    input: null as unknown,
    output: result.output ?? null,
    error: result.error ?? null,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  }));
}

export async function insertExecutionNodes(
  userId: string,
  workspaceId: string,
  executionId: string,
  nodeResults: ReadonlyMap<
    string,
    NodeExecutionResult & { nodeType: string; startedAt: Date; finishedAt: Date }
  >
) {
  await requireWorkspaceMembership(userId, workspaceId);

  if (nodeResults.size === 0) return [];

  return db.insert(executionNodes).values(buildExecutionNodeRows(executionId, nodeResults)).returning();
}

export async function getExecutionById(userId: string, workspaceId: string, executionId: string) {
  await requireWorkspaceMembership(userId, workspaceId);

  const [execution] = await db
    .select()
    .from(executions)
    .where(and(eq(executions.id, executionId), eq(executions.workspaceId, workspaceId)))
    .limit(1);

  if (!execution) return null;

  const nodes = await db
    .select()
    .from(executionNodes)
    .where(eq(executionNodes.executionId, executionId));

  // The one place a redacted copy is produced: this is the read path a
  // human (or the future GET /api/executions/[executionId]) consumes, so
  // it must not hand back a credential. The worker never comes through
  // here — it reads the row directly from claimQueuedExecution, intact.
  return {
    execution: { ...execution, document: redactWorkflowDocument(execution.document) },
    nodes,
  };
}

// ---- MODELO 1 (usuário vivo) — nova, para o futuro caminho assíncrono ----

/**
 * Creates an execution in "queued" — the entry point the future
 * enqueueWorkflowExecution() (4D/4E, not built yet) will call. Not wired
 * to anything yet in this checkpoint; exists so the lifecycle described in
 * docs/async-execution.md has somewhere to start. startedAt stays null
 * until a worker actually claims it — "queued" has no start time yet.
 */
export async function createQueuedExecution(
  userId: string,
  workspaceId: string,
  workflowId: string,
  document: unknown
) {
  await requireWorkspaceMembership(userId, workspaceId);

  const [execution] = await db
    .insert(executions)
    .values({
      workflowId,
      workspaceId,
      status: "queued",
      document,
      triggerType: "manual",
      // Pertence à fila: pode ser reclamada, devolvida para "queued" pelo
      // reaper, e abandonada. É o único runner que o reaper enxerga.
      runner: "worker",
      createdBy: userId,
    })
    .returning();

  // Um INSERT de uma linha com RETURNING devolve exatamente uma linha: ou
  // insere e devolve, ou lança. Zero linhas aqui é falha de infraestrutura e
  // tem de aparecer com esse nome, em vez de propagar `undefined`.
  //
  // Isto NÃO é o mesmo caso das funções de UPDATE deste arquivo, que
  // devolvem `?? null` de propósito: lá o WHERE pode legitimamente não casar
  // (é o guard de cerca), e "nenhuma linha" é uma resposta, não um defeito.
  if (!execution) {
    throw new Error("createQueuedExecution: o INSERT em executions não devolveu a linha criada");
  }

  return execution;
}

// ---- MODELO 2 (worker interno) --------------------------------------------

/**
 * SEMÂNTICA DE claimAttempts (Fase 4G) — um contador de CLAIMS, nada mais.
 *
 * Incrementa em exatamente um lugar conceitual: quando alguém toma posse da
 * execução para executá-la (claimQueuedExecution e claimNextQueuedExecution).
 * O reclaim do reaper NÃO incrementa: ele só devolve a linha para a fila, e
 * quem paga a tentativa é o próximo claim. Uma recuperação custa exatamente
 * uma tentativa, não duas.
 *
 *   criada (createQueuedExecution)   claim_attempts = 0   status = queued
 *   worker A faz claim               claim_attempts = 1   status = running   <- época de A
 *   A trava; reaper faz reclaim      claim_attempts = 1   status = queued    <- inalterado
 *   worker B faz claim               claim_attempts = 2   status = running   <- época de B
 *   ...
 *   worker C faz claim               claim_attempts = 3   status = running   <- época de C
 *   C trava; reaper NÃO reclama      3 < MAX é falso -> abandonExecution
 *                                    status = error, WORKER_CRASHED
 *
 * Ou seja: MAX_CLAIM_ATTEMPTS é o número máximo de execuções tentadas, e o
 * mesmo número aparece nos dois lados da decisão do reaper —
 * reclaimExpiredExecution exige `claim_attempts < MAX` ("ainda cabe outra
 * tentativa") e abandonExecution exige `claim_attempts >= MAX` ("as
 * tentativas acabaram"). As duas condições são complementares e avaliadas
 * atomicamente no banco, nunca em código de aplicação.
 *
 * O valor também é a ÉPOCA que identifica a posse: o worker guarda o
 * claim_attempts que recebeu no próprio claim e o devolve em todo write
 * final (ver finishQueuedExecution e insertExecutionNodesInternal). Como
 * todo claim incrementa, um worker antigo nunca casa com a época corrente.
 *
 * Execuções síncronas (runner = 'request') nunca são reclamadas, então o
 * contador delas fica em 0 para sempre — mas NÃO é isso que as mantém fora
 * do circuito de recuperação; é a coluna runner (0004_execution_runner.sql).
 */
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * LEASE (Fase 9) — o que substituiu "faz muito tempo que começou".
 *
 * Até aqui, "stale" era `started_at` velho demais. Isso responde há quanto
 * tempo a execução começou, e não se alguém ainda está cuidando dela — um
 * worker morto e um worker vivo porém lento são indistinguíveis por esse
 * sinal. O lease é uma afirmação com prazo, escrita pelo próprio dono:
 * "eu estava vivo, e reafirmo isso antes deste instante".
 *
 * LEASE_DURATION_MS é maior que o timeout do próprio engine de propósito.
 * Uma execução legítima que use todo o seu MAX_EXECUTION_TIME_MS não pode
 * perder o lease por isso — e há 15s de folga além disso, que é o que
 * cobre o caso em que nenhuma renovação chegou a rodar (ver a nota sobre
 * event loop em processClaimedExecution).
 *
 * HEARTBEAT_INTERVAL_MS é o passo da renovação: curto o bastante para
 * tolerar várias falhas seguidas dentro de um lease, longo o bastante para
 * não virar polling em cima do banco. Com 5s e 45s, são 9 renovações por
 * lease — 8 podem falhar antes de a execução ficar recuperável.
 */
export const LEASE_DURATION_MS = EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS + 15_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;

function leaseDeadline(leaseMs: number = LEASE_DURATION_MS): Date {
  return new Date(Date.now() + leaseMs);
}

/**
 * "Ninguém está mais segurando esta execução." Avaliado pelo banco contra
 * o estado corrente da linha, no mesmo UPDATE que age sobre ela — nunca
 * contra um valor lido antes.
 *
 * NULL entra como vencido de propósito. Uma linha "running" sem lease é
 * uma linha que ninguém declarou estar executando: ou vem de antes da
 * migration 0005, ou de alguma escrita que não passou pelo claim. Nos dois
 * casos, recuperável é a resposta segura — proteção tem de ser afirmativa.
 */
function leaseHasExpired() {
  return or(isNull(executions.leaseExpiresAt), lt(executions.leaseExpiresAt, new Date()));
}

/**
 * HEARTBEAT: estende o lease do claim corrente.
 *
 * O fencing é exatamente o mesmo de finishQueuedExecution e
 * insertExecutionNodesInternal — id + runner + status + época. Isso é o
 * que garante os três casos que não podem existir:
 *
 *   - um worker antigo NÃO renova depois de perder a posse: o reclaim
 *     devolveu a linha para "queued" e o próximo claim incrementou a
 *     época, então o WHERE não casa mais;
 *   - um heartbeat NÃO ressuscita execução finalizada: exige
 *     `status = 'running'`, e terminal nunca volta;
 *   - um heartbeat NÃO mexe em claimAttempts: o SET toca só o lease, então
 *     renovar não consome tentativa nem desloca a época de ninguém.
 *
 * Retorna null quando a renovação foi recusada — ou seja, "você não é mais
 * o dono". Não é erro: é a resposta correta para um worker que perdeu a
 * corrida, e o chamador deve parar de renovar em vez de insistir.
 */
export async function renewExecutionLease(
  executionId: string,
  expectedClaimAttempts: number,
  options?: { leaseMs?: number }
) {
  const [execution] = await db
    .update(executions)
    .set({ leaseExpiresAt: leaseDeadline(options?.leaseMs) })
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.runner, "worker"),
        eq(executions.status, "running"),
        eq(executions.claimAttempts, expectedClaimAttempts)
      )
    )
    .returning();

  return execution ?? null;
}

/**
 * Atomic claim: queued -> running. A single UPDATE...WHERE...RETURNING —
 * Postgres's row-level locking during the UPDATE is what makes this safe
 * under concurrent callers, not any application-level lock. Returns null
 * if the row wasn't in "queued" anymore (already claimed by someone else,
 * or a duplicate delivery of the same job) — that's the expected,
 * non-error outcome of a race, not a failure to handle specially.
 *
 * No userId/workspaceId parameter, no requireWorkspaceMembership call —
 * MODELO 2. The caller (future worker) must not, and does not need to,
 * supply a workspaceId; whatever workspace this execution belongs to is
 * whatever is already on the row being claimed.
 */
export async function claimQueuedExecution(executionId: string) {
  const [execution] = await db
    .update(executions)
    .set({
      status: "running",
      startedAt: new Date(),
      claimAttempts: sql`${executions.claimAttempts} + 1`,
      // O lease nasce junto com a posse, no mesmo UPDATE atômico: nunca
      // existe um instante em que a linha esteja "running" sem dono
      // declarado.
      leaseExpiresAt: leaseDeadline(),
    })
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.runner, "worker"),
        eq(executions.status, "queued")
      )
    )
    .returning();

  return execution ?? null;
}

/**
 * RECUPERAÇÃO: devolve uma execução travada para a FILA.
 *
 * Antes da Fase 4G esta função fazia `running -> running` (mexendo em
 * startedAt e incrementando claimAttempts). Não recuperava nada: nenhum
 * consumidor procura por "running" — claimNextQueuedExecution só enxerga
 * "queued". O efeito real de um worker morto era falha atrasada, não
 * retomada: a linha era "reclaimada" até esgotar as tentativas e então
 * marcada WORKER_CRASHED, sem nunca ter voltado a rodar.
 *
 * Agora a transição é `running -> queued`, que é o estado que o worker de
 * fato consome. Não há segundo sistema de fila: o próprio status "queued"
 * é a fila (docs/async-execution.md, "Fila — decisão conceitual"), então
 * devolver a linha para lá é literalmente reenfileirar.
 *
 * NÃO incrementa claimAttempts. Quem paga a tentativa é o próximo claim —
 * ver a nota de semântica acima. Incrementar aqui faria uma única
 * recuperação consumir duas tentativas.
 *
 * FASE 9: a condição de recuperabilidade deixou de ser "started_at velho"
 * e passou a ser "o lease acabou". A diferença é a que importa: a primeira
 * pergunta há quanto tempo começou, a segunda pergunta se alguém ainda
 * está cuidando. Um worker vivo que renove o lease nunca é recuperado, por
 * mais que demore; um worker morto deixa o lease vencer em
 * LEASE_DURATION_MS e vira recuperável mesmo que tenha acabado de começar.
 *
 * Lease NULL conta como vencido. Proteção contra recuperação tem de ser
 * afirmativa: uma linha "running" sem lease é uma linha que ninguém
 * declarou estar executando.
 *
 * startedAt volta para null porque "queued" ainda não começou: é a mesma
 * invariante que createQueuedExecution estabelece, e mantê-la significa que
 * startedAt sempre descreve o claim CORRENTE, nunca um anterior.
 *
 * Um único UPDATE condicional, igual a todo o resto deste arquivo: a
 * atomicidade vem do row lock do Postgres durante o UPDATE, não de lock em
 * código. Retorna null quando a linha não estava (mais) elegível —
 * terminou sozinha, outro reaper chegou antes, ou as tentativas acabaram
 * (nesse caso o caller deve tentar abandonExecution).
 */
export async function reclaimExpiredExecution(
  executionId: string,
  options?: { maxAttempts?: number }
) {
  const maxAttempts = options?.maxAttempts ?? MAX_CLAIM_ATTEMPTS;

  const [execution] = await db
    .update(executions)
    .set({
      status: "queued",
      startedAt: null,
      // Volta para a fila sem dono. Obrigatório, não cosmético: o banco
      // recusa uma linha "queued" que ainda carregue lease
      // (executions_lease_only_while_running_check).
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(executions.id, executionId),
        // runner: uma execução síncrona nunca entra aqui (Fase 4G).
        eq(executions.runner, "worker"),
        eq(executions.status, "running"),
        leaseHasExpired(),
        lt(executions.claimAttempts, maxAttempts)
      )
    )
    .returning();

  return execution ?? null;
}

/**
 * Finds candidate stale "running" executions for a reaper sweep — read
 * only, claims nothing itself. The reaper (not built yet) is expected to
 * call reclaimExpiredExecution for each id, and abandonExecution for any
 * that comes back null because claimAttempts was already at the cap.
 */
export async function findStaleRunningExecutionIds() {
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        // Fase 4G: só execuções que pertencem à fila. Sem esta condição,
        // uma execução síncrona viva dentro de uma request HTTP entrava
        // como candidata — reproduzido contra Postgres real.
        eq(executions.runner, "worker"),
        eq(executions.status, "running"),
        // Fase 9: e só as que ninguém está mais segurando.
        leaseHasExpired()
      )
    );

  return rows.map((r) => r.id);
}

/**
 * Terminal transition for an execution the reaper has given up retrying.
 *
 * FIX (found during the 4F audit, corrected here per its explicit
 * instruction to fix inconsistencies within the functions it lists):
 * this WHERE clause used to be just `status = 'running'` — nothing here
 * actually required the row to be stale, or claimAttempts to be at the
 * cap. That meant abandonExecution's own safety depended entirely on its
 * caller (the reaper) only ever invoking it correctly — a single caller
 * bug could abandon a healthy, legitimately-running execution. It now
 * repeats the same staleness + attempts-cap condition as
 * reclaimExpiredExecution, atomically, in the WHERE clause itself — this
 * function can no longer abandon anything that isn't independently
 * verified, by the database, to be both stale AND out of reclaim
 * attempts, regardless of what the caller believes.
 */
export async function abandonExecution(
  executionId: string,
  error: ExecutionError,
  options?: { maxAttempts?: number }
) {
  const maxAttempts = options?.maxAttempts ?? MAX_CLAIM_ATTEMPTS;

  const [execution] = await db
    .update(executions)
    .set({
      status: "error",
      finishedAt: new Date(),
      error,
      // Estado terminal não tem dono.
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.runner, "worker"),
        eq(executions.status, "running"),
        leaseHasExpired(),
        gte(executions.claimAttempts, maxAttempts)
      )
    )
    .returning();

  return execution ?? null;
}

/**
 * Worker-mode insert of execution_nodes — MODELO 2, same reasoning as
 * finishQueuedExecution: no userId/workspaceId, because there's no live
 * user context inside the worker. Shares buildExecutionNodeRows with the
 * MODELO 1 version above so the two paths can't drift on what a persisted
 * node row looks like.
 *
 * FENCED (Fase 4G). Antes da 4G esta função escrevia sem nenhuma condição:
 * bastava ter o executionId. Isso deixou de ser aceitável no momento em que
 * o reclaim passou a devolver execuções para a fila, porque agora uma mesma
 * execução realmente roda mais de uma vez:
 *
 *   worker A roda, grava os nós de A
 *   A trava; reaper devolve a execução para "queued"
 *   worker B reclama, roda, grava os nós de B
 *   -> execution_nodes teria as DUAS tentativas, e quem lesse o histórico
 *      veria cada nó duas vezes sem nada dizendo qual tentativa é qual.
 *
 * Duas coisas resolvem isso, ambas dentro de uma única transação que segura
 * o row lock da execução (`FOR UPDATE`), de modo que o reaper não consegue
 * reclamar a linha no meio:
 *
 *   1. a mesma época do fencing de finishQueuedExecution. Um worker que já
 *      perdeu a posse não escreve nó nenhum — retorna null e descarta o
 *      próprio trabalho.
 *   2. a tentativa corrente SUBSTITUI a anterior. Linhas de uma tentativa
 *      passada pertencem a um claim que não é mais dono desta execução;
 *      acumular seria apresentar como histórico algo que nunca foi um único
 *      run.
 *
 * Retorna null quando a posse foi perdida — distinto de [] (posse válida,
 * nenhum nó a gravar).
 *
 * Nota sobre a API do Drizzle: usa `.for("update")`, a mesma família de
 * `.for("update", { skipLocked: true })` que execution-queue.ts já usa. Como
 * registrado no HANDOFF, nenhuma das duas foi confirmada contra o pacote
 * instalado — node_modules segue indisponível.
 */
export async function insertExecutionNodesInternal(
  executionId: string,
  nodeResults: ReadonlyMap<
    string,
    NodeExecutionResult & { nodeType: string; startedAt: Date; finishedAt: Date }
  >,
  expectedClaimAttempts: number
) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.id, executionId),
          eq(executions.runner, "worker"),
          eq(executions.status, "running"),
          eq(executions.claimAttempts, expectedClaimAttempts)
        )
      )
      .limit(1)
      .for("update");

    if (!owner) return null;

    // Substitui a tentativa anterior, não acumula (ver acima).
    await tx.delete(executionNodes).where(eq(executionNodes.executionId, executionId));

    if (nodeResults.size === 0) return [];

    return tx
      .insert(executionNodes)
      .values(buildExecutionNodeRows(executionId, nodeResults))
      .returning();
  });
}

/**
 * Worker-mode finish: running -> success|error|cancelled, persisting the
 * final result (the piece that was missing before this checkpoint — see
 * docs/async-execution.md's note under "GET /api/executions/[executionId]").
 * No userId/workspaceId — MODELO 2, same reasoning as claimQueuedExecution.
 * This does not replace finishExecution (MODELO 1), which the synchronous
 * path keeps using unchanged.
 *
 * FIX (found during the 4F audit, same class of bug as the one corrected in
 * abandonExecution above): this WHERE clause used to be just
 * `id = executionId` — no status guard, no ownership check. That made the
 * final state of an execution writable by ANY caller holding the id, at any
 * time, over any previous value. Two concrete failures, both reproduced
 * against a real Postgres before this fix:
 *
 *   (1) a worker that stalled long enough for the reaper to abandon its
 *       execution (status "error", WORKER_CRASHED) would, on waking up,
 *       happily overwrite that terminal row with "success" — reporting a
 *       result for a run the system had already given up on and told the
 *       user had failed;
 *   (2) finishing was unconditionally repeatable, so any later call — a
 *       duplicate delivery, a retry, a second worker — silently replaced
 *       an already-final status.
 *
 * Both are now blocked in the WHERE clause itself, by two guards:
 *
 *   status = 'running'
 *     a terminal execution is final; nothing re-opens it. This is what
 *     abandonExecution and reclaimExpiredExecution already required, and
 *     the reason the reaper was safe against scenario E while this
 *     function was not.
 *
 *   claimAttempts = expectedClaimAttempts   (the FENCING TOKEN)
 *     status alone is not enough: after the reaper reclaims a stale
 *     execution it is "running" again, so a status-only guard would still
 *     let the *old*, stalled worker finish a row that now belongs to a
 *     different claim. claimAttempts is already incremented by every claim
 *     path (claimQueuedExecution, claimNextQueuedExecution,
 *     reclaimExpiredExecution) — which makes it, unchanged and with no new
 *     column, a monotonic lease epoch. A worker passes back the value it
 *     received at claim time; if anything re-claimed the row since, the
 *     number moved and this UPDATE matches nothing.
 *
 * Returning null therefore means "you no longer own this execution" — the
 * caller must treat its own result as void and must NOT retry the write.
 * That is a normal, expected outcome under recovery, not an error.
 *
 * Note what this does NOT fix: insertExecutionNodesInternal still writes
 * per-node rows unguarded, so a worker that loses its lease between that
 * insert and this call leaves node rows attached to an execution finalized
 * by someone else. Harmless today (the terminal status, the part a user
 * sees, is now protected) and deliberately left alone — it only becomes
 * reachable once a reclaimed execution is actually re-executed, which is
 * the open design question recorded in docs/async-execution.md.
 */
export async function finishQueuedExecution(
  executionId: string,
  input: {
    status: ExecutionStatus;
    durationMs: number;
    result?: NodeOutput;
    error?: ExecutionError;
    /** The claimAttempts value this worker read from its own successful
     *  claim. Required, not optional: the whole point of this guard is that
     *  it cannot be forgotten at a call site. */
    expectedClaimAttempts: number;
  }
) {
  const [execution] = await db
    .update(executions)
    .set({
      status: input.status,
      finishedAt: new Date(),
      durationMs: input.durationMs,
      result: input.result ?? null,
      error: input.error ?? null,
      // Estado terminal não tem dono — e o banco recusaria a linha com
      // lease em qualquer status que não seja "running".
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(executions.id, executionId),
        // Sem isto, um caller passando expectedClaimAttempts: 0 casaria com
        // uma execução SÍNCRONA em andamento (que fica em 0 para sempre).
        eq(executions.runner, "worker"),
        eq(executions.status, "running"),
        eq(executions.claimAttempts, input.expectedClaimAttempts)
      )
    )
    .returning();

  return execution ?? null;
}
