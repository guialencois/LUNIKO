import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { WorkflowDocument } from "@/lib/workflows/types";

/**
 * Integration tests for the bounded worker invocation (Fase 4I) — the
 * consumer that Supabase Cron wakes over HTTP.
 *
 * Requires TEST_DATABASE_URL with migrations 0000-0004 applied; skipped,
 * not faked, otherwise.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("runWorkerInvocation (4I, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let repo: typeof import("./execution-repository");
  let producer: typeof import("./enqueue-workflow-execution");
  let worker: typeof import("./run-worker-invocation");
  let reaper: typeof import("./recovery-reaper");
  let workflowMutations: typeof import("@/server/workflows/mutations");

  let workspaceA: string;
  let userA: string;
  let workflowA: string;

  const validDocument: WorkflowDocument = {
    schemaVersion: 1,
    nodes: [
      { id: "t", type: "manualTrigger", name: "t", position: { x: 0, y: 0 }, data: {} },
      { id: "s", type: "set", name: "s", position: { x: 200, y: 0 }, data: { values: { ok: true } } },
    ],
    edges: [{ id: "e1", source: "t", target: "s" }],
    settings: { executionMode: "default" },
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    repo = await import("./execution-repository");
    producer = await import("./enqueue-workflow-execution");
    worker = await import("./run-worker-invocation");
    reaper = await import("./recovery-reaper");
    workflowMutations = await import("@/server/workflows/mutations");

    userA = crypto.randomUUID();
    const [wsA] = await db
      .insert(schema.workspaces)
      .values({ name: "4I Test Workspace" })
      .returning({ id: schema.workspaces.id });
    workspaceA = wsA!.id;

    await db
      .insert(schema.workspaceMembers)
      .values({ workspaceId: workspaceA, userId: userA, role: "owner" });

    const workflow = await workflowMutations.createWorkflow(userA, workspaceA, {
      name: "4I test workflow",
      description: "",
    });
    workflowA = workflow.id;

    await db
      .update(schema.workflows)
      .set({ document: validDocument })
      .where(eq(schema.workflows.id, workflowA));
  });

  afterAll(async () => {
    if (!hasTestDb) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA));
  });

  /** Empties the queue so each test starts from a known state. */
  async function drain() {
    await worker.runWorkerInvocation({ maxJobs: 50 });
  }

  async function enqueue() {
    return producer.enqueueWorkflowExecution({
      userId: userA,
      workspaceId: workspaceA,
      workflowId: workflowA,
    });
  }

  it("1+2. finds a queued job through its own discovery and processes it", async () => {
    await drain();
    const queued = await enqueue();

    const summary = await worker.runWorkerInvocation();

    expect(summary.jobs.map((j) => j.executionId)).toContain(queued.executionId);
    expect(summary.succeeded).toBe(1);

    const row = await repo.getExecutionById(userA, workspaceA, queued.executionId);
    expect(row?.execution.status).toBe("success");
    expect(row?.nodes).toHaveLength(2);
  });

  it("3. returns immediately when the queue is empty", async () => {
    await drain();

    const summary = await worker.runWorkerInvocation();

    expect(summary.claimed).toBe(0);
    expect(summary.stoppedBy).toBe("empty_queue");
    expect(summary.jobs).toEqual([]);
  });

  it("4. stops at the per-invocation job cap, leaving the rest queued", async () => {
    await drain();
    for (let i = 0; i < 4; i++) await enqueue();

    const summary = await worker.runWorkerInvocation({ maxJobs: 2 });

    expect(summary.claimed).toBe(2);
    expect(summary.stoppedBy).toBe("max_jobs");

    // The two it didn't take are still queued and still claimable.
    const rest = await worker.runWorkerInvocation({ maxJobs: 50 });
    expect(rest.claimed).toBe(2);
  });

  it("5. stops on its deadline without claiming a job it cannot finish", async () => {
    await drain();
    await enqueue();

    // A budget smaller than the reserve means there is never room to start
    // even the first job — so nothing may be claimed, and the execution
    // must be left untouched rather than claimed and abandoned.
    const summary = await worker.runWorkerInvocation({ budgetMs: 1_000 });

    expect(summary.claimed).toBe(0);
    expect(summary.stoppedBy).toBe("deadline");

    const stillQueued = await worker.runWorkerInvocation({ maxJobs: 50 });
    expect(stillQueued.claimed).toBe(1);
  });

  it("6. two concurrent invocations never process the same execution", async () => {
    await drain();
    const queued = await Promise.all([enqueue(), enqueue(), enqueue(), enqueue()]);
    const ids = queued.map((q) => q.executionId);

    const [a, b] = await Promise.all([
      worker.runWorkerInvocation({ maxJobs: 50 }),
      worker.runWorkerInvocation({ maxJobs: 50 }),
    ]);

    const processed = [...a.jobs, ...b.jobs].map((j) => j.executionId);
    // Every job ran, and none ran twice — SKIP LOCKED partitioned them.
    expect(new Set(processed).size).toBe(processed.length);
    for (const id of ids) {
      const row = await repo.getExecutionById(userA, workspaceA, id);
      expect(row?.execution.status).toBe("success");
      expect(row?.execution.claimAttempts).toBe(1); // claimed exactly once
    }
  });

  it("7. drains several jobs in a single invocation", async () => {
    await drain();
    for (let i = 0; i < 3; i++) await enqueue();

    const summary = await worker.runWorkerInvocation({ maxJobs: 10 });

    expect(summary.claimed).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.stoppedBy).toBe("empty_queue");
  });

  it("8. a job that fails does not stop the rest of the queue", async () => {
    await drain();

    // A workflow whose document cannot be planned: the processor records it
    // as a failed execution rather than throwing out of the loop.
    const broken = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
    const healthy = await enqueue();

    const summary = await worker.runWorkerInvocation({ maxJobs: 10 });

    expect(summary.claimed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);

    const brokenRow = await repo.getExecutionById(userA, workspaceA, broken.id);
    const healthyRow = await repo.getExecutionById(userA, workspaceA, healthy.executionId);
    expect(brokenRow?.execution.status).toBe("error");
    expect(healthyRow?.execution.status).toBe("success");
  });

  it("9. the reaper runs independently of the worker and executes nothing", async () => {
    await drain();
    const queued = await enqueue();

    // Claim it and let it go stale, as a dead worker would.
    const claimed = await repo.claimQueuedExecution(queued.executionId);
    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, queued.executionId));

    const summary = await reaper.recoverStaleExecutions({ maxAttempts: 3 });

    expect(summary.decisions.find((d) => d.executionId === queued.executionId)?.outcome).toBe(
      "reclaimed"
    );

    const row = await repo.getExecutionById(userA, workspaceA, queued.executionId);
    expect(row?.execution.status).toBe("queued"); // back in the queue
    expect(row?.nodes).toHaveLength(0); // the reaper ran no workflow
    expect(row?.execution.claimAttempts).toBe(claimed!.claimAttempts); // no attempt spent

    // ...and the worker can now pick it up again.
    const afterRecovery = await worker.runWorkerInvocation({ maxJobs: 10 });
    expect(afterRecovery.jobs.map((j) => j.executionId)).toContain(queued.executionId);
  });
});
