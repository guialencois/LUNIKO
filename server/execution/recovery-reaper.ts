import {
  findStaleRunningExecutionIds,
  reclaimExpiredExecution,
  abandonExecution,
} from "./execution-repository";
import { ExecutionErrorCode } from "@/lib/execution/errors";

/**
 * The recovery/reaper mechanism for "running" executions that may have
 * been abandoned by a crashed worker (docs/async-execution.md,
 * "Recuperação após crash do worker"). This module NEVER runs a workflow —
 * it only moves lifecycle state, reusing the exact same atomic functions
 * the repository owns (findStaleRunningExecutionIds,
 * reclaimExpiredExecution, abandonExecution). No engine, no executor, no
 * external call, no new lock.
 *
 * THE CYCLE THIS CLOSES (Fase 4G)
 *
 *   queued -> claim -> running -> worker runs -> finish
 *
 * and, when the worker dies mid-run:
 *
 *   running (stale) -> reclaim -> queued -> another worker claims ->
 *   running -> finish
 *
 * The reclaim half is what changed in 4G: it now returns the execution to
 * "queued", the state a worker actually consumes, instead of leaving it in
 * "running" where nothing ever picked it up. There is no second queue —
 * "queued" IS the queue — so handing the row back to that status is the
 * whole re-enqueue mechanism. This file still never executes anything; the
 * next claimNextQueuedExecution() does.
 *
 * WHAT THIS FILE WILL NEVER SEE
 * Only executions whose `runner` is "worker". A synchronous execution
 * (runner "request", running inside a live HTTP request) is not a worker
 * job and is excluded in the repository's own WHERE clauses, with the
 * database refusing to let such a row reach "queued" at all
 * (0004_execution_runner.sql). Before 4G it was indistinguishable from a
 * dead worker and could be abandoned as WORKER_CRASHED.
 *
 * ============================================================
 * THE LIMITATION THIS FILE STILL DOES NOT HIDE
 * ============================================================
 * A Fase 9 trocou o sinal de recuperabilidade: antes era `started_at`
 * velho demais ("faz muito tempo que começou"), agora é o lease vencido
 * ("ninguém reafirmou que está cuidando disto"). A diferença é real — um
 * worker vivo que renove o lease não é mais recuperado por ser lento.
 *
 * Mas isso NÃO é o mesmo que saber que um worker morreu:
 *
 * - Um processo congelado não renova. Se descongelar depois do prazo,
 *   volta achando que é dono de uma execução já entregue a outro. O que
 *   impede o estrago não é o lease, é o FENCING por época — o worker
 *   antigo não renova, não grava nós e não finaliza. O lease reduz a
 *   frequência do cenário; o fencing garante a correção dele.
 *
 * - A renovação depende do event loop do worker. Um executor que bloqueie
 *   o loop impede o heartbeat de disparar, e um worker perfeitamente vivo
 *   deixa o lease vencer. LEASE_DURATION_MS é maior que o timeout do
 *   engine justamente para dar folga a esse caso — folga não é garantia.
 *
 * - E o principal: lease e fencing protegem o ESTADO no banco. Nenhum dos
 *   dois desfaz efeito externo. Se um nó mandar mensagem antes de o worker
 *   travar, o reclaim entrega o trabalho a outro worker e a mensagem sai
 *   de novo — o fencing impede o primeiro de gravar o resultado, não
 *   impede o WhatsApp de ter sido enviado duas vezes. Isso é idempotência
 *   por integração, que é outra fase.
 */

export interface RecoveryOptions {
  /** Só o teto de tentativas é parametrizável. A recuperabilidade em si
   *  não é: vem do lease da própria linha, avaliado pelo banco. */
  maxAttempts?: number;
}

/** "reclaimed" here means "returned to the queue", not "run again by the
 *  reaper" — this module never executes anything. */
export type RecoveryOutcome = "reclaimed" | "abandoned" | "skipped";

export interface RecoveryDecision {
  executionId: string;
  outcome: RecoveryOutcome;
}

export interface RecoverySummary {
  inspected: number;
  reclaimed: number;
  abandoned: number;
  skipped: number;
  decisions: RecoveryDecision[];
}

/**
 * One recovery pass. Not a loop, not a scheduler — a single, callable
 * sweep (item 14: "não implementar loop infinito de processo do worker").
 * Whoever calls this repeatedly (a cron, a future worker's own idle-time
 * check, anything) is out of scope here.
 */
export async function recoverStaleExecutions(
  options: RecoveryOptions = {}
): Promise<RecoverySummary> {
  // Candidatos: linhas de worker em "running" cujo lease já venceu. Cada
  // chamada abaixo reavalia essa condição atomicamente contra o estado
  // corrente da linha, então um lease renovado entre o scan e a ação
  // simplesmente faz a ação não casar.
  const staleIds = await findStaleRunningExecutionIds();

  const decisions: RecoveryDecision[] = [];
  let reclaimed = 0;
  let abandoned = 0;
  let skipped = 0;

  for (const executionId of staleIds) {
    const outcome = await recoverOne(executionId, options);
    decisions.push({ executionId, outcome });
    if (outcome === "reclaimed") reclaimed++;
    else if (outcome === "abandoned") abandoned++;
    else skipped++;
  }

  return { inspected: staleIds.length, reclaimed, abandoned, skipped, decisions };
}

/**
 * Decision for a single stale candidate. Never calls the engine — only
 * reclaimExpiredExecution / abandonExecution, both atomic CAS updates.
 *
 * Handles every one of the concurrency scenarios this phase's task named
 * explicitly, all for the same underlying reason: both repository calls
 * re-evaluate their WHERE condition against whatever the row's *current*
 * state actually is at UPDATE time, under Postgres's row lock — not
 * against the state this function observed a moment earlier in
 * findStaleRunningExecutionIds's SELECT. So:
 *
 * - (scenario D) two reapers racing on the same id: at most one of the two
 *   reclaimExpiredExecution calls can succeed — the moment the first
 *   commits, the row is "queued", so the second one's `status = running`
 *   no longer matches when it acquires the lock, and it returns null. That
 *   second reaper then tries abandonExecution, which requires
 *   `status = running` too, so it also returns null: this function reports
 *   "skipped" for that reaper, not a double re-enqueue. Note this is also
 *   why the reclaim must not increment claimAttempts — the losing reaper
 *   never reaches the row, so a recovery costs exactly one attempt, paid
 *   later by whichever worker actually claims it.
 * - (scenario E) the row finished (success/error/cancelled) between the
 *   SELECT and this function running: both reclaimExpiredExecution and
 *   abandonExecution require `status = 'running'` in their own WHERE —
 *   neither can touch a row that already finished, no matter how this
 *   function is called.
 * - (scenario F) claimAttempts already at the cap: reclaimExpiredExecution
 *   returns null (its own WHERE excludes it), so this function falls
 *   through to abandonExecution, whose WHERE now matches — "abandoned".
 *   The two conditions are complementary (`< max` vs `>= max`), both
 *   evaluated by the database against the row's current state, so a
 *   candidate is always exactly one of "re-enqueue it" or "give up".
 * - execution deleted / id no longer exists at all: both calls simply
 *   affect 0 rows and return null, same as any other non-match — no
 *   exception, no special-casing needed (item 8).
 */
async function recoverOne(
  executionId: string,
  options: RecoveryOptions
): Promise<RecoveryOutcome> {
  const reclaimedRow = await reclaimExpiredExecution(executionId, {
    maxAttempts: options.maxAttempts,
  });
  if (reclaimedRow) return "reclaimed";

  const abandonedRow = await abandonExecution(
    executionId,
    {
      code: ExecutionErrorCode.WORKER_CRASHED,
      message:
        "Execution abandoned by the recovery reaper: its lease expired and it had already used its reclaim attempts.",
    },
    { maxAttempts: options.maxAttempts }
  );
  if (abandonedRow) return "abandoned";

  return "skipped";
}
