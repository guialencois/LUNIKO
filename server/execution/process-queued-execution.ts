import { buildExecutionPlan } from "@/lib/execution/planner";
import { runExecutionPlan } from "@/lib/execution/executor";
import { ExecutionEngineError, ExecutionErrorCode } from "@/lib/execution/errors";
import { defaultInitialInput } from "@/lib/execution/data";
import {
  claimQueuedExecution,
  finishQueuedExecution,
  insertExecutionNodesInternal,
  renewExecutionLease,
  HEARTBEAT_INTERVAL_MS,
} from "./execution-repository";
import type { ExecutionError, ExecutionLogger, NodeOutput } from "@/lib/execution/types";
import type { ExecutionRow } from "@/lib/db/schema";
import { createEffectRunner } from "./effects/effect-runner";

/**
 * The worker's PROCESSOR — not a loop, not a reaper, not an API. Given an
 * executionId it already decided to work on (from claimNextQueuedExecution
 * in 4D, or any other source), this is the one function that turns
 * "queued" into a finished execution. It orchestrates three pieces that
 * already exist and are not touched here: the claim (4C's
 * claimQueuedExecution), the engine (Fase 3's planner+executor, completely
 * unchanged), and persistence (4C's finishQueuedExecution + the new
 * insertExecutionNodesInternal). No new lifecycle rule is introduced here
 * — this function is orchestration only.
 */

export type ProcessQueuedExecutionOutcome =
  | {
      executionId: string;
      status: "success" | "error" | "cancelled";
      result?: NodeOutput;
      error?: ExecutionError;
    }
  | {
      executionId: string;
      /** "not_claimable": the claim didn't succeed — the execution wasn't
       *  "queued" anymore (already claimed by another caller, already
       *  finished, etc.). The workflow was NOT executed.
       *
       *  "lease_lost": the claim DID succeed and the workflow DID run, but
       *  by the time this processor tried to write the final state the
       *  execution no longer belonged to it — the recovery reaper had
       *  reclaimed or abandoned it in the meantime (see
       *  finishQueuedExecution's fencing guard in execution-repository.ts).
       *  Nothing was persisted for this attempt and nothing must be
       *  retried here: whoever holds the current claim decides this
       *  execution's outcome. Expected under recovery, not a bug. */
      status: "skipped";
      reason: "not_claimable" | "lease_lost";
    };

export interface ProcessQueuedExecutionOptions {
  /** Forwarded straight to the (unchanged) engine's own cancellation
   *  support. There is no persisted "cancellation requested" flag yet
   *  (that's 4H) — this is the only cancellation channel available today,
   *  and only works if the caller holding this AbortController aborts it
   *  itself, in-process. */
  signal?: AbortSignal;
}

/** Minimal structured console logger — intentionally the same shape as
 *  execute-workflow.ts's own (not imported from there, to avoid touching
 *  that file at all in this checkpoint; see the 4E report for why). */
function createProcessorLogger(executionId: string): ExecutionLogger {
  const base = (level: string, message: string, meta?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
      JSON.stringify({ level, executionId, source: "worker", message, ...meta })
    );
  };
  return {
    info: (message, meta) => base("info", message, meta),
    warn: (message, meta) => base("warn", message, meta),
    error: (message, meta) => base("error", message, meta),
  };
}

/**
 * Entry point A: "process THIS execution id". Claims it first, then hands
 * the claimed row to processClaimedExecution below.
 *
 * queued -> running is a single atomic CAS. If it returns null, someone
 * else (or a duplicate delivery of the same job) already claimed it, or it
 * isn't queued anymore for any other reason — the workflow must NOT run a
 * second time.
 */
export async function processQueuedExecution(
  executionId: string,
  options: ProcessQueuedExecutionOptions = {}
): Promise<ProcessQueuedExecutionOutcome> {
  const claimed = await claimQueuedExecution(executionId);
  if (!claimed) {
    return { executionId, status: "skipped", reason: "not_claimable" };
  }

  return processClaimedExecution(claimed, options);
}

/**
 * Entry point B: "process a row I have ALREADY claimed".
 *
 * This split exists because the two ways a worker can acquire a job claim
 * it in different places, and stacking them double-claims:
 * claimNextQueuedExecution() (execution-queue.ts, 4D) does the discovery
 * AND the claim in one transaction under FOR UPDATE SKIP LOCKED, so by the
 * time it returns a row that row is already "running" — and calling
 * processQueuedExecution() with its id would find nothing in "queued",
 * report "not_claimable", and never run the workflow. The queue
 * documentation always said these two entry points "must converge into the
 * same worker lifecycle semantics"; this is that convergence, rather than a
 * second copy of the lifecycle living inside the worker.
 *
 * Everything after the claim — the lease epoch, the engine call, the fenced
 * writes — is identical for both entry points because it is literally the
 * same code.
 */
export async function processClaimedExecution(
  claimed: ExecutionRow,
  options: ProcessQueuedExecutionOptions = {}
): Promise<ProcessQueuedExecutionOutcome> {
  const executionId = claimed.id;

  // The fencing token for this attempt. claimQueuedExecution just
  // incremented claimAttempts and returned the resulting row, so this is
  // the epoch that identifies *this* claim. Every write below carries it,
  // so if the reaper reclaims the execution while the engine is running,
  // this processor's final write matches nothing instead of overwriting
  // the new owner's (or the reaper's terminal) state.
  const leaseEpoch = claimed.claimAttempts;

  const logger = createProcessorLogger(executionId);
  const startedAt = Date.now();

  /**
   * HEARTBEAT (Fase 9) — renova o lease enquanto o engine roda.
   *
   * Cobre EXCLUSIVAMENTE a fase do engine, e é parado no `finally` antes
   * da persistência. A persistência abre transação com row lock sobre esta
   * mesma linha, na mesma conexão (`max: 1`); um heartbeat enfileirado
   * atrás dela só adiciona interação para raciocinar, sem ganho. E
   * persistência travada É worker travado — deixar o lease vencer ali é o
   * comportamento certo, não uma falha.
   *
   * O QUE ISTO NÃO GARANTE, e é importante não confundir: a renovação é um
   * timer, ou seja, uma macrotask. O engine encadeia `await` sobre
   * executores puros, que resolvem na fila de microtasks — drenada antes
   * de o event loop chegar aos timers. Medido: um workflow inteiramente
   * puro executa sem que UM único heartbeat dispare. Um bloqueio síncrono
   * tem o mesmo efeito. Ou seja, hoje — com todos os executores puros e
   * execuções de milissegundos — este heartbeat é praticamente inerte, e
   * quem limita um worker travado é o lease concedido no claim. Ele passa
   * a valer quando existir I/O real (um nó HTTP, uma chamada de IA), que é
   * exatamente quando execuções ficam longas o bastante para um falso
   * reclaim importar.
   *
   * Uma renovação recusada significa "você não é mais o dono": o timer
   * para, e a escrita final vai falhar no fencing de qualquer forma. Não
   * abortamos o engine — o trabalho restante é desperdício de CPU, não
   * risco de correção, e abortar só trocaria um descarte por outro.
   */
  let renewalInFlight = false;
  const heartbeat = setInterval(() => {
    if (renewalInFlight) return; // nunca empilhar renovações
    renewalInFlight = true;
    void renewExecutionLease(executionId, leaseEpoch)
      .then((renewed) => {
        if (!renewed) {
          clearInterval(heartbeat);
          logger.warn("Lease renewal refused; this worker no longer owns the execution", {
            leaseEpoch,
          });
        }
      })
      .catch((err) => {
        // Uma renovação que falha por erro transitório não derruba a
        // execução: o lease ainda tem margem para várias tentativas.
        logger.warn("Lease renewal failed", {
          leaseEpoch,
          reason: err instanceof Error ? err.message : "unknown",
        });
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, HEARTBEAT_INTERVAL_MS);
  // Não segurar o processo vivo só por causa do timer. O cast existe
  // porque setInterval tem tipos diferentes em DOM (number) e Node
  // (Timeout); só o Node tem unref, e é lá que isto roda.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  // claimed.document is the snapshot taken when the execution was created
  // (createQueuedExecution, 4C) — this is the only source of the
  // WorkflowDocument used here. Nothing in this function re-fetches
  // workflows.document, and nothing here trusts workspaceId/document from
  // anywhere but this row.

  let planningError: ExecutionError | null = null;
  let outcome:
    | Awaited<ReturnType<typeof runExecutionPlan>>
    | null = null;

  try {
    const plan = buildExecutionPlan(claimed.workflowId, claimed.document);
    outcome = await runExecutionPlan(plan, {
      executionId,
      workflowId: claimed.workflowId,
      workspaceId: claimed.workspaceId,
      // No input travels through the queue (docs/async-execution.md: the
      // job is only {executionId}) — same default the synchronous path
      // uses when the caller didn't supply one.
      initialInput: defaultInitialInput(),
      logger,
      signal: options.signal,
      // Fase 10: the epoch identifies THIS attempt, and the effect runner is
      // bound to it. Decisions an executor makes about external operations
      // are fenced by this epoch still owning the execution; facts it
      // reports are fenced only by it having made the call.
      epoch: leaseEpoch,
      effects: createEffectRunner({
        executionId,
        workspaceId: claimed.workspaceId,
        epoch: leaseEpoch,
      }),
    });
  } catch (err) {
    // Planning failures (invalid document, cycle, no/multiple manual
    // trigger) never reach runExecutionPlan — normalized the same way
    // execute-workflow.ts already does for the synchronous path, so the
    // two don't disagree on error shape.
    planningError =
      err instanceof ExecutionEngineError
        ? err.toExecutionError()
        : {
            code: ExecutionErrorCode.WORKFLOW_INVALID,
            message: err instanceof Error ? err.message : "Unknown execution error",
          };
  } finally {
    // Sempre, inclusive se o engine lançou: um timer vazado renovaria o
    // lease de uma execução que este worker não está mais processando.
    clearInterval(heartbeat);
  }

  const durationMs = Date.now() - startedAt;

  if (planningError) {
    const finished = await finishQueuedExecution(executionId, {
      status: "error",
      durationMs,
      error: planningError,
      expectedClaimAttempts: leaseEpoch,
    });
    if (!finished) {
      logger.warn("Lease lost before persisting planning failure; result discarded", {
        leaseEpoch,
      });
      return { executionId, status: "skipped", reason: "lease_lost" };
    }
    return { executionId, status: "error", error: planningError };
  }

  // outcome is guaranteed non-null here: either planningError was set above
  // (handled and returned already) or runExecutionPlan completed.
  const result = outcome!;

  // Persist per-node results before the final status — same ordering
  // execute-workflow.ts already uses, so a reader querying execution_nodes
  // right after seeing a terminal status never finds it empty.
  //
  // Fenced with the same epoch as the finish below (4G): now that a
  // reclaim really does send an execution back to the queue to be run
  // again, a worker that lost its lease must not write node rows either —
  // otherwise execution_nodes would show two attempts blended together.
  const nodesWritten = await insertExecutionNodesInternal(
    executionId,
    result.nodeResults,
    leaseEpoch
  );

  if (nodesWritten === null) {
    logger.warn("Lease lost before persisting node results; result discarded", {
      leaseEpoch,
      computedStatus: result.status,
    });
    return { executionId, status: "skipped", reason: "lease_lost" };
  }

  const finished = await finishQueuedExecution(executionId, {
    status: result.status,
    durationMs,
    result: result.status === "success" ? result.finalOutput : undefined,
    error: result.error,
    expectedClaimAttempts: leaseEpoch,
  });

  // null = the fencing guard rejected the write: this processor no longer
  // owns the execution (reclaimed or abandoned by the reaper mid-run). Its
  // computed result is void — reporting it as this execution's outcome
  // would be exactly the lie the guard exists to prevent.
  if (!finished) {
    logger.warn("Lease lost before persisting final state; result discarded", {
      leaseEpoch,
      computedStatus: result.status,
    });
    return { executionId, status: "skipped", reason: "lease_lost" };
  }

  if (result.status === "success") {
    return { executionId, status: "success", result: result.finalOutput };
  }
  // "error" or "cancelled" — never silently upgraded to "success" (item 4:
  // a cancelled or failed run must be reported as such, not masked).
  return { executionId, status: result.status, error: result.error };
}
