import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

/**
 * Integration tests for the 4E processor. Same rationale as every other
 * *.integration.test.ts in this project: claim atomicity and "only one of
 * two concurrent calls actually runs the workflow" are not meaningfully
 * testable against a mock — they depend on real Postgres row locking.
 * Requires TEST_DATABASE_URL with migrations 0000-0003 applied; skipped,
 * not faked, otherwise.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("processQueuedExecution (4E, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let repo: typeof import("./execution-repository");
  let processor: typeof import("./process-queued-execution");
  let workflowMutations: typeof import("@/server/workflows/mutations");

  let workspaceA: string;
  let userA: string;
  let workflowA: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    repo = await import("./execution-repository");
    processor = await import("./process-queued-execution");
    workflowMutations = await import("@/server/workflows/mutations");

    userA = crypto.randomUUID();
    const [wsA] = await db
      .insert(schema.workspaces)
      .values({ name: "4E Test Workspace" })
      .returning({ id: schema.workspaces.id });
    workspaceA = wsA!.id;

    await db.insert(schema.workspaceMembers).values({
      workspaceId: workspaceA,
      userId: userA,
      role: "owner",
    });

    const workflow = await workflowMutations.createWorkflow(userA, workspaceA, {
      name: "4E test workflow",
      description: "",
    });
    workflowA = workflow.id;
  });

  afterAll(async () => {
    if (!hasTestDb) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA));
  });

  function node(id: string, type: string, data: Record<string, unknown> = {}) {
    return { id, type, name: id, position: { x: 0, y: 0 }, data };
  }
  function edge(id: string, source: string, target: string) {
    return { id, source, target };
  }

  async function createQueuedWithDocument(document: unknown) {
    return repo.createQueuedExecution(userA, workspaceA, workflowA, document);
  }

  it("executes successfully: Manual -> Set, persists result and execution_nodes", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("s", "set", { values: { ok: true } })],
      edges: [edge("e1", "t", "s")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);

    const outcome = await processor.processQueuedExecution(created.id);

    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.result?.items).toEqual([{ json: { ok: true } }]);
    }

    const persisted = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(persisted?.execution.status).toBe("success");
    expect(persisted?.execution.result).toEqual({ items: [{ json: { ok: true } }] });
    expect(persisted?.nodes.length).toBe(2);
  });

  it("reports error for an invalid workflow document (planning failure)", async () => {
    const invalidDoc = { schemaVersion: 1, nodes: [node("s", "set")], edges: [] }; // no manualTrigger, missing settings
    const created = await createQueuedWithDocument(invalidDoc);

    const outcome = await processor.processQueuedExecution(created.id);

    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.error?.code).toBeDefined();
    }

    const persisted = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(persisted?.execution.status).toBe("error");
    expect(persisted?.nodes.length).toBe(0); // never reached node execution
  });

  it("reports error when a node fails (NOT_IMPLEMENTED), fail-fast preserved", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("h", "httpRequest"), node("after", "set")],
      edges: [edge("e1", "t", "h"), edge("e2", "h", "after")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);

    const outcome = await processor.processQueuedExecution(created.id);

    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.error?.code).toBe("NOT_IMPLEMENTED");
    }

    const persisted = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(persisted?.nodes.some((n) => n.nodeId === "after")).toBe(false); // fail-fast
  });

  it("reports cancelled, never upgraded to success, when the signal is already aborted", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("s", "set")],
      edges: [edge("e1", "t", "s")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);
    const controller = new AbortController();
    controller.abort();

    const outcome = await processor.processQueuedExecution(created.id, { signal: controller.signal });

    expect(outcome.status).toBe("cancelled");

    const persisted = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(persisted?.execution.status).toBe("cancelled");
    expect(persisted?.execution.result).toBeNull();
  });

  it("skips (never executes) an execution that doesn't exist", async () => {
    const outcome = await processor.processQueuedExecution(crypto.randomUUID());
    expect(outcome).toEqual({
      executionId: expect.any(String),
      status: "skipped",
      reason: "not_claimable",
    });
  });

  it("skips an execution that is already 'running'", async () => {
    const created = await createQueuedWithDocument({
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger")],
      edges: [],
      settings: { executionMode: "default" },
    });
    await repo.claimQueuedExecution(created.id); // now running

    const outcome = await processor.processQueuedExecution(created.id);
    expect(outcome.status).toBe("skipped");
  });

  it.each(["success", "error", "cancelled"] as const)(
    "skips an execution that is already '%s'",
    async (terminalStatus) => {
      const created = await createQueuedWithDocument({
        schemaVersion: 1,
        nodes: [node("t", "manualTrigger")],
        edges: [],
        settings: { executionMode: "default" },
      });
      await db
        .update(schema.executions)
        .set({ status: terminalStatus })
        .where(eq(schema.executions.id, created.id));

      const outcome = await processor.processQueuedExecution(created.id);
      expect(outcome.status).toBe("skipped");
    }
  );

  it("two concurrent calls for the same executionId: only one actually runs the workflow", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("s", "set")],
      edges: [edge("e1", "t", "s")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);

    const [outcomeA, outcomeB] = await Promise.all([
      processor.processQueuedExecution(created.id),
      processor.processQueuedExecution(created.id),
    ]);

    const ran = [outcomeA, outcomeB].filter((o) => o.status !== "skipped");
    const skipped = [outcomeA, outcomeB].filter((o) => o.status === "skipped");
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(1);

    // The workflow ran exactly once — execution_nodes has exactly the 2
    // nodes from a single run, not 4 from two runs.
    const persisted = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(persisted?.nodes.length).toBe(2);
  });
  // ------------------------------------------------------------------
  // 4F: the fencing guard on finishQueuedExecution.
  //
  // These are the cases that were silently broken before the 4F audit and
  // are the reason expectedClaimAttempts exists. All four were first
  // reproduced as raw SQL against a real Postgres (the unguarded UPDATE
  // did overwrite terminal state); they live here so the shipped
  // TypeScript path is covered too once dependencies can be installed.
  // ------------------------------------------------------------------

  /** Puts a claimed execution into a given age/attempt state, the way a
   *  stalled worker would look to the reaper. Returns the epoch the
   *  *original* worker is still holding. */
  async function claimThenStall(overrides: { leaseExpired: boolean; claimAttempts: number }) {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("s", "set")],
      edges: [edge("e1", "t", "s")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);
    const claimed = await repo.claimQueuedExecution(created.id);
    const workerEpoch = claimed!.claimAttempts;

    await db
      .update(schema.executions)
      .set({
        // Fase 9: o sinal que o reaper lê é o lease, não startedAt.
        ...(overrides.leaseExpired ? { leaseExpiresAt: new Date(Date.now() - 1_000) } : {}),
        claimAttempts: overrides.claimAttempts,
      })
      .where(eq(schema.executions.id, created.id));

    return { executionId: created.id, workerEpoch };
  }

  const MAX_ATTEMPTS = 3;

  it("4F: a stalled worker cannot overwrite an execution the reaper abandoned", async () => {
    const { executionId, workerEpoch } = await claimThenStall({
      leaseExpired: true,
      claimAttempts: MAX_ATTEMPTS, // reclaim attempts exhausted
    });

    const abandoned = await repo.abandonExecution(
      executionId,
      { code: "WORKER_CRASHED", message: "abandoned" },
      { maxAttempts: MAX_ATTEMPTS }
    );
    expect(abandoned).not.toBeNull();

    // The stalled worker finally comes back and reports success.
    const finished = await repo.finishQueuedExecution(executionId, {
      status: "success",
      durationMs: 1,
      result: { items: [{ json: {} }] },
      expectedClaimAttempts: workerEpoch,
    });

    expect(finished).toBeNull(); // write rejected, not applied
    const row = await repo.getExecutionById(userA, workspaceA, executionId);
    expect(row?.execution.status).toBe("error");
    expect((row?.execution.error as { code?: string })?.code).toBe("WORKER_CRASHED");
  });

  it("4F: a stalled worker cannot finish an execution the reaper reclaimed", async () => {
    // This is the case a status-only guard would NOT catch: after a
    // reclaim the row is "running" again, so only the claimAttempts epoch
    // distinguishes the old owner from the new one.
    const { executionId, workerEpoch } = await claimThenStall({
      leaseExpired: true,
      claimAttempts: 1,
    });

    const reclaimed = await repo.reclaimExpiredExecution(executionId, {
            maxAttempts: MAX_ATTEMPTS,
    });
    expect(reclaimed).not.toBeNull();
    // 4G: back to the queue, and the attempt is not spent here.
    expect(reclaimed!.status).toBe("queued");
    expect(reclaimed!.claimAttempts).toBe(workerEpoch);

    // The stalled worker wakes up: it can't finish a queued row...
    expect(
      await repo.finishQueuedExecution(executionId, {
        status: "success",
        durationMs: 1,
        expectedClaimAttempts: workerEpoch,
      })
    ).toBeNull();

    // A new worker picks it up — THIS is what spends the attempt.
    const second = await repo.claimQueuedExecution(executionId);
    expect(second!.claimAttempts).toBe(workerEpoch + 1);

    // ...and the old worker still can't finish, now for the epoch reason
    // rather than the status one. This is the case a status-only guard
    // would miss: the row is "running" again, just not his.
    expect(
      await repo.finishQueuedExecution(executionId, {
        status: "success",
        durationMs: 1,
        expectedClaimAttempts: workerEpoch,
      })
    ).toBeNull();

    // The CURRENT owner finishes normally.
    const byNewOwner = await repo.finishQueuedExecution(executionId, {
      status: "success",
      durationMs: 1,
      expectedClaimAttempts: second!.claimAttempts,
    });
    expect(byNewOwner).not.toBeNull();
  });

  it("4F: a terminal execution cannot be re-finished by a duplicate call", async () => {
    const { executionId, workerEpoch } = await claimThenStall({ leaseExpired: false, claimAttempts: 1 });

    const first = await repo.finishQueuedExecution(executionId, {
      status: "success",
      durationMs: 1,
      expectedClaimAttempts: workerEpoch,
    });
    expect(first).not.toBeNull();

    const second = await repo.finishQueuedExecution(executionId, {
      status: "error",
      durationMs: 1,
      error: { code: "NODE_EXECUTION_FAILED", message: "late duplicate" },
      expectedClaimAttempts: workerEpoch,
    });

    expect(second).toBeNull();
    const row = await repo.getExecutionById(userA, workspaceA, executionId);
    expect(row?.execution.status).toBe("success"); // first result stands
  });

  it("4F: the processor reports lease_lost instead of a result it no longer owns", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("d", "delay", { duration: 1, unit: "seconds" })],
      edges: [edge("e1", "t", "d")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);

    // Start the processor, then yank the lease out from under it while the
    // delay node is still running.
    const running = processor.processQueuedExecution(created.id);
    await new Promise((r) => setTimeout(r, 100));
    await db
      .update(schema.executions)
      .set({ claimAttempts: 99 }) // simulates any re-claim by the reaper
      .where(eq(schema.executions.id, created.id));

    const outcome = await running;

    expect(outcome.status).toBe("skipped");
    expect(outcome.status === "skipped" && outcome.reason).toBe("lease_lost");

    // The execution was NOT finalized by the processor that lost its lease.
    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("running");
  });

  // ------------------------------------------------------------------
  // Redaction: the document the worker executes must be the document the
  // user authored. The defect these cover stored redact(document), and
  // this path runs the STORED row — so a Set field named "bookingKey"
  // was executed as "[REDACTED]".
  // ------------------------------------------------------------------

  const reservaValues = {
    bookingKey: "LEN-2026-0417",
    passageiro: "Ana Souza",
    tokenVoucher: "V-88213",
    diaria: "1250",
  };

  it("executes the user's own field names untouched (bookingKey, tokenVoucher)", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("s", "set", { values: reservaValues })],
      edges: [edge("e1", "t", "s")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);

    const outcome = await processor.processQueuedExecution(created.id);
    expect(outcome.status).toBe("success");

    // The values the run produced are the ones that were authored.
    const produced = outcome.status === "success" ? outcome.result?.items[0]?.json : undefined;
    expect(produced).toMatchObject(reservaValues);
    expect(JSON.stringify(produced)).not.toContain("[REDACTED]");

    // ...and the stored snapshot still is the authored document, so the
    // execution stays reproducible from its own row.
    const [stored] = await db
      .select({ document: schema.executions.document })
      .from(schema.executions)
      .where(eq(schema.executions.id, created.id));
    if (!stored) throw new Error("a execução não está no banco");
    expect(JSON.stringify(stored.document)).not.toContain("[REDACTED]");
    expect(stored.document).toEqual(doc);
  });

  it("gives the worker the real credential and the reader a redacted copy", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        node("t", "manualTrigger"),
        node("h", "httpRequest", {
          method: "POST",
          url: "https://api.exemplo/reservas",
          headers: { Authorization: "Bearer sk-live-9f3a2b", "Content-Type": "application/json" },
          query: {},
          body: null,
        }),
      ],
      edges: [edge("e1", "t", "h")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);

    // `typeof doc` não serve para ler estes campos: o helper `node()` tipa
    // `data` como Record<string, unknown>, então `data.headers` sai como
    // `unknown`. Este é o formato que os asserts abaixo de fato leem.
    type HttpRequestNodeDoc = {
      nodes: { data: { url: string; headers: Record<string, string> } }[];
    };

    // MODELO 2, the worker's own read: intact, because it has to be able
    // to actually send that header once httpRequest is implemented.
    const claimed = await repo.claimQueuedExecution(created.id);
    const claimedNode = (claimed!.document as HttpRequestNodeDoc).nodes[1];
    expect(claimedNode?.data.headers.Authorization).toBe("Bearer sk-live-9f3a2b");

    // MODELO 1, the read path a human consumes: redacted.
    const read = await repo.getExecutionById(userA, workspaceA, created.id);
    const readNode = (read!.execution.document as HttpRequestNodeDoc).nodes[1];
    expect(readNode?.data.headers.Authorization).toBe("[REDACTED]");
    // ...but only the credential header, not the rest of the document.
    expect(readNode?.data.headers["Content-Type"]).toBe("application/json");
    expect(readNode?.data.url).toBe("https://api.exemplo/reservas");
  });

  // ------------------------------------------------------------------
  // 4G: o ciclo de recuperação fecha. Antes desta fase o reclaim devolvia
  // a linha para "running", que nenhum consumidor procura — a execução
  // nunca voltava a rodar, só era abandonada mais tarde.
  // ------------------------------------------------------------------

  function nodeResult(nodeId: string) {
    return new Map([
      [
        nodeId,
        {
          status: "success" as const,
          durationMs: 1,
          output: { items: [{ json: {} }] },
          nodeType: "set",
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      ],
    ]);
  }

  it("4G: a stalled execution goes back to the queue and is actually re-run", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("s", "set", { values: { tentativa: "real" } })],
      edges: [edge("e1", "t", "s")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);

    // Worker A claims, gets as far as writing its node rows, then stalls.
    const a = await repo.claimQueuedExecution(created.id);
    const epochA = a!.claimAttempts;
    expect(await repo.insertExecutionNodesInternal(created.id, nodeResult("no-de-A"), epochA)).not.toBeNull();

    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, created.id));

    // The reaper hands it back to the queue.
    const reclaimed = await repo.reclaimExpiredExecution(created.id, {
            maxAttempts: MAX_ATTEMPTS,
    });
    expect(reclaimed!.status).toBe("queued");

    // ...and the worker path picks it up and runs it to completion. This
    // is the assertion that would have failed before 4G: processQueued
    // only claims "queued", so a reclaimed-to-"running" row was invisible.
    const outcome = await processor.processQueuedExecution(created.id);
    expect(outcome.status).toBe("success");

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.execution.status).toBe("success");
    expect(row?.execution.claimAttempts).toBe(epochA + 1); // the re-claim spent it

    // The second attempt replaced the first: one run's worth of nodes.
    expect(row?.nodes.map((n) => n.nodeId).sort()).toEqual(["s", "t"]);
  });

  it("4G: a worker that lost its lease cannot write execution_nodes", async () => {
    const doc = {
      schemaVersion: 1,
      nodes: [node("t", "manualTrigger"), node("s", "set")],
      edges: [edge("e1", "t", "s")],
      settings: { executionMode: "default" },
    };
    const created = await createQueuedWithDocument(doc);

    const a = await repo.claimQueuedExecution(created.id);
    const epochA = a!.claimAttempts;

    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, created.id));
    await repo.reclaimExpiredExecution(created.id, { maxAttempts: MAX_ATTEMPTS });

    const b = await repo.claimQueuedExecution(created.id);
    // Both calls below hit a row that IS "running" — only the epoch tells
    // the two workers apart.
    expect(await repo.insertExecutionNodesInternal(created.id, nodeResult("tardio-de-A"), epochA)).toBeNull();
    expect(
      await repo.insertExecutionNodesInternal(created.id, nodeResult("de-B"), b!.claimAttempts)
    ).not.toBeNull();

    const row = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(row?.nodes.map((n) => n.nodeId)).toEqual(["de-B"]);
  });
});
