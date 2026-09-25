import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

/**
 * Integration tests for the queue PRODUCER (Fase 4H) and for the chain it
 * finally connects: API -> queued execution -> enqueue -> worker claim ->
 * process -> fenced finish. Until this phase createQueuedExecution had no
 * call site outside tests, so the whole asynchronous lifecycle was
 * reachable only from tests.
 *
 * Requires TEST_DATABASE_URL with migrations 0000-0004 applied; skipped,
 * not faked, otherwise.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("enqueueWorkflowExecution (4H, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let repo: typeof import("./execution-repository");
  let queue: typeof import("./execution-queue");
  let producer: typeof import("./enqueue-workflow-execution");
  let worker: typeof import("./run-worker-invocation");
  let workflowMutations: typeof import("@/server/workflows/mutations");

  let workspaceA: string;
  let userA: string;
  let strangerId: string;
  let workflowA: string;

  const validDocument = {
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
    queue = await import("./execution-queue");
    producer = await import("./enqueue-workflow-execution");
    worker = await import("./run-worker-invocation");
    workflowMutations = await import("@/server/workflows/mutations");

    userA = crypto.randomUUID();
    strangerId = crypto.randomUUID();

    const [wsA] = await db
      .insert(schema.workspaces)
      .values({ name: "4H Test Workspace" })
      .returning({ id: schema.workspaces.id });
    workspaceA = wsA.id;

    await db.insert(schema.workspaceMembers).values({
      workspaceId: workspaceA,
      userId: userA,
      role: "owner",
    });

    const workflow = await workflowMutations.createWorkflow(userA, workspaceA, {
      name: "4H test workflow",
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

  async function enqueue() {
    return producer.enqueueWorkflowExecution({
      userId: userA,
      workspaceId: workspaceA,
      workflowId: workflowA,
    });
  }

  it("1. creates a queued, worker-owned execution and returns only its id and status", async () => {
    const queued = await enqueue();

    expect(queued).toEqual({ executionId: expect.any(String), status: "queued" });

    const [row] = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.id, queued.executionId));

    expect(row.status).toBe("queued");
    expect(row.runner).toBe("worker"); // the reaper's circuit, not the request's
    expect(row.startedAt).toBeNull();
    expect(row.claimAttempts).toBe(0);
    // The snapshot is what will actually run, stored intact.
    expect(row.document).toEqual(validDocument);
  });

  it("2. does NOT execute anything during the call", async () => {
    const queued = await enqueue();

    const persisted = await repo.getExecutionById(userA, workspaceA, queued.executionId);
    expect(persisted?.execution.status).toBe("queued");
    expect(persisted?.execution.result).toBeNull();
    expect(persisted?.execution.error).toBeNull();
    expect(persisted?.execution.finishedAt).toBeNull();
    // The engine never ran: no per-node rows exist.
    expect(persisted?.nodes).toHaveLength(0);
  });

  it("3. the queued execution is picked up by the worker's own discovery and runs to completion", async () => {
    // The whole chain this phase exists to connect. Nothing hands the
    // worker an id — runWorkerInvocation discovers the job through
    // claimNextQueuedExecution, exactly as the scheduled function does.
    //
    // NOTE: this test previously called claimNextQueuedExecution() and then
    // processQueuedExecution(id). That was wrong and never ran (vitest is
    // blocked): claimNextQueuedExecution already claims the row, so the
    // second claim inside processQueuedExecution found nothing in "queued"
    // and returned "not_claimable" without executing anything. The worker
    // now uses processClaimedExecution for exactly that reason.
    const queued = await enqueue();

    const summary = await worker.runWorkerInvocation();

    expect(summary.jobs.map((j) => j.executionId)).toContain(queued.executionId);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);

    const finished = await repo.getExecutionById(userA, workspaceA, queued.executionId);
    expect(finished?.execution.status).toBe("success");
    expect(finished?.execution.finishedAt).not.toBeNull();
    expect(finished?.nodes.map((n) => n.nodeId).sort()).toEqual(["s", "t"]);
  });

  it("4. refuses a workflow that doesn't exist, without creating a row", async () => {
    const before = await db.select().from(schema.executions);

    await expect(
      producer.enqueueWorkflowExecution({
        userId: userA,
        workspaceId: workspaceA,
        workflowId: crypto.randomUUID(),
      })
    ).rejects.toThrow(/could not be found/i);

    const after = await db.select().from(schema.executions);
    expect(after.length).toBe(before.length);
  });

  it("5. refuses a caller who is not a member of the workspace", async () => {
    await expect(
      producer.enqueueWorkflowExecution({
        userId: strangerId,
        workspaceId: workspaceA,
        workflowId: workflowA,
      })
    ).rejects.toThrow();
  });

  it("6. refuses an unexecutable document at the boundary, without queueing it", async () => {
    // A brand-new workflow's document is empty — no manual trigger, so the
    // planner rejects it. The point is that this is caught BEFORE a job
    // exists, instead of becoming a queued execution that can only fail.
    const empty = await workflowMutations.createWorkflow(userA, workspaceA, {
      name: "empty",
      description: "",
    });

    await expect(
      producer.enqueueWorkflowExecution({
        userId: userA,
        workspaceId: workspaceA,
        workflowId: empty.id,
      })
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.workflowId, empty.id));
    expect(rows).toHaveLength(0);
  });

  it("7. enqueueing the same execution twice is safe while it is still queued", async () => {
    const queued = await enqueue();

    // Re-validating an already-queued job is a no-op that yields the same
    // descriptor — no second row, no second job.
    await expect(queue.enqueueExecution(queued.executionId)).resolves.toEqual({
      executionId: queued.executionId,
    });

    const rows = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.id, queued.executionId));
    expect(rows).toHaveLength(1);

    // Once a worker owns it, re-enqueueing correctly stops succeeding.
    await repo.claimQueuedExecution(queued.executionId);
    await expect(queue.enqueueExecution(queued.executionId)).rejects.toMatchObject({
      code: "EXECUTION_NOT_QUEUEABLE",
    });
  });

  it("8. two API calls produce two independent executions, not one shared job", async () => {
    const first = await enqueue();
    const second = await enqueue();

    expect(first.executionId).not.toBe(second.executionId);

    const rows = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.workflowId, workflowA));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(first.executionId);
    expect(ids).toContain(second.executionId);
  });
});
