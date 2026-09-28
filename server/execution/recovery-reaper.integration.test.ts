import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

/**
 * Integration tests for the 4F reaper. Same rationale as every other
 * *.integration.test.ts here: atomicity under concurrent callers isn't
 * meaningfully testable against a mock. Requires TEST_DATABASE_URL with
 * migrations 0000-0003 applied; skipped, not faked, otherwise.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("recovery reaper (4F, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let repo: typeof import("./execution-repository");
  let reaper: typeof import("./recovery-reaper");
  let workflowMutations: typeof import("@/server/workflows/mutations");

  let workspaceA: string;
  let userA: string;
  let workflowA: string;

  const MAX_ATTEMPTS = 3;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    repo = await import("./execution-repository");
    reaper = await import("./recovery-reaper");
    workflowMutations = await import("@/server/workflows/mutations");

    userA = crypto.randomUUID();
    const [wsA] = await db
      .insert(schema.workspaces)
      .values({ name: "4F Test Workspace" })
      .returning({ id: schema.workspaces.id });
    workspaceA = wsA!.id;

    await db.insert(schema.workspaceMembers).values({
      workspaceId: workspaceA,
      userId: userA,
      role: "owner",
    });

    const workflow = await workflowMutations.createWorkflow(userA, workspaceA, {
      name: "4F test workflow",
      description: "",
    });
    workflowA = workflow.id;
  });

  afterAll(async () => {
    if (!hasTestDb) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA));
  });

  const emptyDoc = {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    settings: { executionMode: "default" },
  };

  /**
   * Fase 9: "tornar recuperável" deixou de ser retroagir startedAt e passou
   * a ser vencer o lease — que é o sinal que o reaper de fato lê agora.
   */
  async function createRunning(overrides?: { leaseExpired?: boolean; claimAttempts?: number }) {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, emptyDoc);
    await repo.claimQueuedExecution(created.id); // queued -> running, claimAttempts 1, lease concedido
    if (overrides) {
      await db
        .update(schema.executions)
        .set({
          ...(overrides.leaseExpired ? { leaseExpiresAt: new Date(Date.now() - 1_000) } : {}),
          ...(overrides.claimAttempts !== undefined ? { claimAttempts: overrides.claimAttempts } : {}),
        })
        .where(eq(schema.executions.id, created.id));
    }
    return created;
  }

  it("1. leaves a 'running' execution whose lease is still valid untouched", async () => {
    const created = await createRunning(); // lease recém-concedido, ainda válido
    const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });

    const decision = summary.decisions.find((d) => d.executionId === created.id);
    expect(decision).toBeUndefined(); // never even inspected — not stale

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("running");
  });

  it("2. reclaims a stale 'running' execution that still has reclaim attempts left", async () => {
    const created = await createRunning({
      leaseExpired: true,
      claimAttempts: 1,
    });

    const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });

    const decision = summary.decisions.find((d) => d.executionId === created.id);
    expect(decision?.outcome).toBe("reclaimed");
    expect(summary.reclaimed).toBeGreaterThanOrEqual(1);

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    // 4G: back to the queue, not to "running" — that's what makes the
    // recovery an actual recovery instead of a delayed failure.
    expect(row?.execution.status).toBe("queued");
    expect(row?.execution.startedAt).toBeNull();
    expect(row?.execution.claimAttempts).toBe(1); // reclaim spends nothing
  });

  it("3. abandons a stale 'running' execution once claimAttempts is at the cap", async () => {
    const created = await createRunning({
      leaseExpired: true,
      claimAttempts: MAX_ATTEMPTS,
    });

    const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });

    const decision = summary.decisions.find((d) => d.executionId === created.id);
    expect(decision?.outcome).toBe("abandoned");

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("error");
    expect(row?.execution.error).toMatchObject({ code: "WORKER_CRASHED" });
  });

  it.each(["success", "error", "cancelled"] as const)(
    "4. never touches an execution already '%s', even if it looks stale by timestamp",
    async (terminalStatus) => {
      const created = await createRunning({ leaseExpired: true });
      await db
        .update(schema.executions)
        // Terminar é também SOLTAR O LEASE. O CHECK
        // executions_lease_only_while_running_check (migration 0005) admite
        // lease apenas com runner='worker' E status='running', porque estado
        // terminal não tem dono — é exatamente o que finishQueuedExecution faz
        // (`leaseExpiresAt: null`). Este teste simulava o fim mexendo só no
        // status, e o banco recusava a linha, com razão. O título ainda fala
        // "by timestamp" porque é anterior ao lease, que veio na Fase 9.
        .set({ status: terminalStatus, finishedAt: new Date(), leaseExpiresAt: null })
        .where(eq(schema.executions.id, created.id));

      const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });

      // findStaleRunningExecutionIds only looks at status='running', so a
      // terminal execution is never even a candidate.
      expect(summary.decisions.find((d) => d.executionId === created.id)).toBeUndefined();

      const row = await repo.getExecutionById(userA, workspaceA, created.id);
      expect(row?.execution.status).toBe(terminalStatus); // untouched
    }
  );

  it("5. a just-reclaimed execution is not immediately abandoned in the same or a following pass", async () => {
    const created = await createRunning({
      leaseExpired: true,
      claimAttempts: 1,
    });

    const firstPass = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });
    expect(firstPass.decisions.find((d) => d.executionId === created.id)?.outcome).toBe("reclaimed");

    // Immediately run another pass: the execution is queued now, and the
    // sweep only ever looks at "running" — so it isn't even a candidate,
    // let alone abandoned.
    const secondPass = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });
    expect(secondPass.decisions.find((d) => d.executionId === created.id)).toBeUndefined();

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("queued");
  });

  it("6. two concurrent reaper passes never double-recover the same execution incorrectly", async () => {
    const created = await createRunning({
      leaseExpired: true,
      claimAttempts: 1,
    });

    const [summaryA, summaryB] = await Promise.all([
      reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS }),
      reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS }),
    ]);

    const outcomes = [
      summaryA.decisions.find((d) => d.executionId === created.id)?.outcome,
      summaryB.decisions.find((d) => d.executionId === created.id)?.outcome,
    ].filter(Boolean);

    // At most one pass actually reclaimed it; the other either never saw
    // it as a candidate (lost the SELECT race timing) or saw it and both
    // reclaim/abandon correctly no-op'd (lost the UPDATE race) — either
    // way, never two "reclaimed".
    const reclaims = outcomes.filter((o) => o === "reclaimed");
    expect(reclaims.length).toBeLessThanOrEqual(1);

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    // Whoever won put it back in the queue exactly once, and neither pass
    // spent an attempt doing it.
    expect(row?.execution.status).toBe("queued");
    expect(row?.execution.claimAttempts).toBe(1);
  });

  it("7. the reaper never executes the workflow — no execution_nodes, no result", async () => {
    const reclaimCandidate = await createRunning({
      leaseExpired: true,
      claimAttempts: 1,
    });
    const abandonCandidate = await createRunning({
      leaseExpired: true,
      claimAttempts: MAX_ATTEMPTS,
    });

    await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });

    const reclaimedRow = await repo.getExecutionById(userA, workspaceA, reclaimCandidate.id);
    expect(reclaimedRow?.nodes).toHaveLength(0);
    expect(reclaimedRow?.execution.result).toBeNull();

    const abandonedRow = await repo.getExecutionById(userA, workspaceA, abandonCandidate.id);
    expect(abandonedRow?.nodes).toHaveLength(0);
    expect(abandonedRow?.execution.result).toBeNull();
  });

  it("8. an execution deleted between discovery and recovery doesn't crash the sweep", async () => {
    const created = await createRunning({
      leaseExpired: true,
      claimAttempts: 1,
    });
    // Simulate the row disappearing before the reaper gets to it — deleting
    // it directly (a workflow/workspace cascade would do the same thing).
    await db.delete(schema.executions).where(eq(schema.executions.id, created.id));

    await expect(
      reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS })
    ).resolves.toBeDefined(); // does not throw
  });

  it("9. the summary's counts are internally coherent", async () => {
    await createRunning({ leaseExpired: true, claimAttempts: 1 }); // reclaim
    await createRunning({ leaseExpired: true, claimAttempts: MAX_ATTEMPTS }); // abandon
    await createRunning(); // lease recém-concedido, ainda válido, not a candidate at all

    const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });

    expect(summary.inspected).toBe(summary.decisions.length);
    expect(summary.reclaimed + summary.abandoned + summary.skipped).toBe(summary.inspected);
    for (const decision of summary.decisions) {
      const countedOutcome =
        decision.outcome === "reclaimed"
          ? summary.reclaimed
          : decision.outcome === "abandoned"
            ? summary.abandoned
            : summary.skipped;
      expect(countedOutcome).toBeGreaterThan(0);
    }
  });

  // ------------------------------------------------------------------
  // 4G: o lifecycle síncrono fica FORA do circuito de recuperação.
  // Antes desta fase o reaper procurava candidatos só por status
  // "running", e uma execução síncrona viva dentro de uma request HTTP
  // era indistinguível de um worker morto.
  // ------------------------------------------------------------------

  it("4G: a synchronous execution is never a recovery candidate", async () => {
    const sync = await repo.createExecution(userA, workspaceA, workflowA, emptyDoc);
    expect(sync.runner).toBe("request");

    // Desde a migration 0005 este teste não consegue nem MONTAR o cenário que
    // guardava — e isso é uma garantia mais forte que a original. O CHECK
    // executions_lease_only_while_running_check admite lease só com
    // runner='worker', então uma execução síncrona não pode ter lease; e é por
    // lease vencido que o reaper procura. O estado perigoso deixou de ser
    // inalcançável pelo código e passou a ser irrepresentável no banco.
    let bancoRecusou = false;
    try {
      await db
        .update(schema.executions)
        .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.executions.id, sync.id));
    } catch {
      bancoRecusou = true;
    }
    expect(bancoRecusou).toBe(true);

    // E, sem lease, nenhuma varredura a enxerga — quatro passagens seguidas,
    // que era a sequência que antes a levava de claimAttempts 0 até
    // WORKER_CRASHED sem worker nenhum envolvido.
    for (let i = 0; i < 4; i++) {
      const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });
      expect(summary.decisions.find((d) => d.executionId === sync.id)).toBeUndefined();
    }

    const row = await repo.getExecutionById(userA, workspaceA, sync.id);
    expect(row?.execution.status).toBe("running");
    expect(row?.execution.claimAttempts).toBe(0);

    // And it still finishes normally through its own path.
    const finished = await repo.finishExecution(userA, workspaceA, sync.id, {
      status: "success",
      durationMs: 1,
    });
    expect(finished).not.toBeNull();
  });

  it("4G: a late synchronous finish cannot overwrite a recovered execution", async () => {
    const created = await createRunning({
      leaseExpired: true,
      claimAttempts: MAX_ATTEMPTS,
    });
    await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });

    const abandoned = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(abandoned?.execution.status).toBe("error");

    // finishExecution is the synchronous path's write. It must not be able
    // to reach a worker-owned row at all — the mirror of the fencing guard
    // on the asynchronous side.
    const late = await repo.finishExecution(userA, workspaceA, created.id, {
      status: "success",
      durationMs: 1,
    });
    expect(late).toBeNull();

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("error");
    expect((row?.execution.error as { code?: string })?.code).toBe("WORKER_CRASHED");
  });

  // ------------------------------------------------------------------
  // Fase 9: lease / heartbeat. O sinal de recuperabilidade deixou de ser
  // "started_at velho" e passou a ser "lease vencido". O heartbeat usa o
  // MESMO fencing por época das escritas finais.
  // ------------------------------------------------------------------

  async function leaseOf(executionId: string) {
    const [row] = await db
      .select({ lease: schema.executions.leaseExpiresAt, attempts: schema.executions.claimAttempts })
      .from(schema.executions)
      .where(eq(schema.executions.id, executionId));
    // Toda chamada é sobre uma execução que o próprio teste acabou de criar.
    // Não encontrar a linha é defeito do teste, e tem de falhar aqui com nome
    // em vez de virar `undefined` nos onze usos espalhados abaixo.
    if (!row) throw new Error(`leaseOf: execução ${executionId} não encontrada`);
    return row;
  }

  it("A. the current owner renews its own lease", async () => {
    const created = await createRunning({ leaseExpired: true });
    // leaseOf já devolve { lease, attempts } desta mesma linha — é o helper
    // usado nos outros testes deste arquivo para ler a época.
    const epoch = (await leaseOf(created.id)).attempts;

    const renewed = await repo.renewExecutionLease(created.id, epoch);

    expect(renewed).not.toBeNull();
    expect((await leaseOf(created.id)).lease!.getTime()).toBeGreaterThan(Date.now());
  });

  it("D. renewing changes neither claimAttempts nor status", async () => {
    const created = await createRunning();
    const before = await leaseOf(created.id);

    await repo.renewExecutionLease(created.id, before.attempts);
    await repo.renewExecutionLease(created.id, before.attempts);

    const after = await leaseOf(created.id);
    expect(after.attempts).toBe(before.attempts);
    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("running");
  });

  it("E. an execution with a valid lease is never recovered", async () => {
    const created = await createRunning(); // lease acabou de ser concedido

    for (let i = 0; i < 3; i++) {
      const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });
      expect(summary.decisions.find((d) => d.executionId === created.id)).toBeUndefined();
    }

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("running");
    expect(row?.execution.claimAttempts).toBe(1);
  });

  it("F. an execution whose lease expired becomes recoverable, and returns leaseless", async () => {
    const created = await createRunning({ leaseExpired: true });

    const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });

    expect(summary.decisions.find((d) => d.executionId === created.id)?.outcome).toBe("reclaimed");
    const row = await leaseOf(created.id);
    expect(row.lease).toBeNull(); // fila não tem dono
  });

  it("B+G. a superseded worker can neither renew nor keep the new owner's lease alive", async () => {
    const created = await createRunning({ leaseExpired: true });
    const epochA = (await leaseOf(created.id)).attempts;

    await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS }); // volta para a fila
    const b = await repo.claimQueuedExecution(created.id); // B assume
    const epochB = b!.claimAttempts;
    expect(epochB).toBe(epochA + 1);

    // B trava; A acorda e tenta renovar com a época antiga.
    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, created.id));

    expect(await repo.renewExecutionLease(created.id, epochA)).toBeNull();
    // ...e o lease continua vencido, ou seja, A não ressuscitou a execução
    // de B: ela segue recuperável.
    expect((await leaseOf(created.id)).lease!.getTime()).toBeLessThan(Date.now());
    const summary = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });
    expect(summary.decisions.find((d) => d.executionId === created.id)?.outcome).toBe("reclaimed");
  });

  it("C+H. a heartbeat after the execution finished is rejected", async () => {
    const created = await createRunning();
    const epoch = (await leaseOf(created.id)).attempts;

    const finished = await repo.finishQueuedExecution(created.id, {
      status: "success",
      durationMs: 1,
      expectedClaimAttempts: epoch,
    });
    expect(finished).not.toBeNull();
    // O finish limpa o lease: estado terminal não tem dono.
    expect((await leaseOf(created.id)).lease).toBeNull();

    expect(await repo.renewExecutionLease(created.id, epoch)).toBeNull();
    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("success"); // não voltou a running
  });

  it("I. renewing before a sweep keeps the execution out of the reaper's reach", async () => {
    const created = await createRunning({ leaseExpired: true });
    const epoch = (await leaseOf(created.id)).attempts;

    // Renova bem na frente da varredura.
    await repo.renewExecutionLease(created.id, epoch);
    const guarded = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });
    expect(guarded.decisions.find((d) => d.executionId === created.id)).toBeUndefined();

    // Para de renovar: vira recuperável.
    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, created.id));
    const recovered = await reaper.recoverStaleExecutions({ maxAttempts: MAX_ATTEMPTS });
    expect(recovered.decisions.find((d) => d.executionId === created.id)?.outcome).toBe("reclaimed");
  });
});
