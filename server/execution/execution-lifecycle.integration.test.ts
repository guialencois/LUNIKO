import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

/**
 * Integration tests for the 4C lifecycle/persistence layer. Require a real
 * Postgres reachable via TEST_DATABASE_URL, with migrations 0000-0003
 * applied. Skipped — not faked — when that's not available, which is the
 * case in the sandbox this checkpoint was written in. Same pattern as
 * server/workflows/workflows.integration.test.ts (Fase 2).
 *
 * Claim atomicity in particular is not meaningfully testable any other
 * way: it depends on real Postgres row-level locking under concurrent
 * transactions, which a mock would just assert against itself.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("execution lifecycle (4C, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let repo: typeof import("./execution-repository");
  let workflowMutations: typeof import("@/server/workflows/mutations");

  let workspaceA: string;
  let workspaceB: string;
  let userA: string;
  let userB: string;
  let workflowA: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    repo = await import("./execution-repository");
    workflowMutations = await import("@/server/workflows/mutations");

    userA = crypto.randomUUID();
    userB = crypto.randomUUID();

    const [wsA] = await db
      .insert(schema.workspaces)
      .values({ name: "4C Test Workspace A" })
      .returning({ id: schema.workspaces.id });
    const [wsB] = await db
      .insert(schema.workspaces)
      .values({ name: "4C Test Workspace B" })
      .returning({ id: schema.workspaces.id });
    workspaceA = wsA.id;
    workspaceB = wsB.id;

    await db.insert(schema.workspaceMembers).values([
      { workspaceId: workspaceA, userId: userA, role: "owner" },
      { workspaceId: workspaceB, userId: userB, role: "owner" },
    ]);

    const workflow = await workflowMutations.createWorkflow(userA, workspaceA, {
      name: "4C test workflow",
      description: "",
    });
    workflowA = workflow.id;
  });

  afterAll(async () => {
    if (!hasTestDb) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceB));
  });

  it("1. creates an execution in 'queued', with no startedAt and 0 claim attempts", async () => {
    const execution = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });

    expect(execution.status).toBe("queued");
    expect(execution.startedAt).toBeNull();
    expect(execution.claimAttempts).toBe(0);
    expect(execution.result).toBeNull();
  });

  it("2. claimQueuedExecution atomically moves queued -> running", async () => {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });

    const claimed = await repo.claimQueuedExecution(created.id);

    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("running");
    expect(claimed!.startedAt).not.toBeNull();
    expect(claimed!.claimAttempts).toBe(1);
  });

  it("2b. claiming an already-running execution returns null", async () => {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
    await repo.claimQueuedExecution(created.id);

    const secondClaim = await repo.claimQueuedExecution(created.id);
    expect(secondClaim).toBeNull();
  });

  it("3. two concurrent claims on the same execution: exactly one wins", async () => {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });

    const [first, second] = await Promise.all([
      repo.claimQueuedExecution(created.id),
      repo.claimQueuedExecution(created.id),
    ]);

    const winners = [first, second].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("4. persists the final result on finishQueuedExecution", async () => {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
    await repo.claimQueuedExecution(created.id);

    const result = { items: [{ json: { ok: true } }] };
    const finished = await repo.finishQueuedExecution(created.id, {
      status: "success",
      durationMs: 42,
      result,
    });

    expect(finished!.status).toBe("success");
    expect(finished!.result).toEqual(result);
    expect(finished!.finishedAt).not.toBeNull();
  });

  it("5. status transitions: queued -> running -> success, and separately -> error", async () => {
    const success = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
    expect(success.status).toBe("queued");
    const claimedSuccess = await repo.claimQueuedExecution(success.id);
    expect(claimedSuccess!.status).toBe("running");
    const finishedSuccess = await repo.finishQueuedExecution(success.id, {
      status: "success",
      durationMs: 10,
      result: { items: [] },
    });
    expect(finishedSuccess!.status).toBe("success");

    const failed = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
    await repo.claimQueuedExecution(failed.id);
    const finishedError = await repo.finishQueuedExecution(failed.id, {
      status: "error",
      durationMs: 5,
      error: { code: "NODE_EXECUTION_FAILED", message: "boom", nodeId: "n1" },
    });
    expect(finishedError!.status).toBe("error");
    expect(finishedError!.error).toMatchObject({ code: "NODE_EXECUTION_FAILED" });
  });

  it("6. recovers a stale 'running' execution via reclaimExpiredExecution", async () => {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
    await repo.claimQueuedExecution(created.id);

    // Simulate "stuck running for a long time" without actually waiting —
    // back-date startedAt directly, the same column reclaimExpiredExecution
    // checks.
    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, created.id));

    const reclaimed = await repo.reclaimExpiredExecution(created.id);
    expect(reclaimed).not.toBeNull();
    // 4G: recovery returns the execution to the QUEUE — the state a worker
    // actually consumes — instead of leaving it "running", where nothing
    // ever picked it up again.
    expect(reclaimed!.status).toBe("queued");
    expect(reclaimed!.startedAt).toBeNull(); // "queued" hasn't started yet
    // ...and it does NOT spend an attempt: the next claim does that, so one
    // recovery costs exactly one attempt rather than two.
    expect(reclaimed!.claimAttempts).toBe(1);

    // A second reclaim finds nothing to do: the row is queued now, and
    // reclaim only ever acts on "running".
    expect(await repo.reclaimExpiredExecution(created.id)).toBeNull();

    // E uma execução recém-reclamada tem lease válido, então também não
    // é recuperável — agora por ter dono, não por ser recente.
    await repo.claimQueuedExecution(created.id);
    expect(await repo.reclaimExpiredExecution(created.id)).toBeNull();
  });

  it("6b. reclaimExpiredExecution returns null once claimAttempts hits the cap, and abandonExecution then closes it", async () => {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
    await repo.claimQueuedExecution(created.id); // attempt 1
    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000), claimAttempts: 3 })
      .where(eq(schema.executions.id, created.id));

    const reclaimed = await repo.reclaimExpiredExecution(created.id, {
            maxAttempts: 3,
    });
    expect(reclaimed).toBeNull(); // already at the cap

    // abandonExecution verifica lease vencido E o teto de tentativas no
    // próprio WHERE — nenhuma das duas condições vem do caller.
    const abandoned = await repo.abandonExecution(
      created.id,
      {
        code: "WORKER_CRASHED",
        message: "Execution abandoned after repeated worker failures",
      },
      { maxAttempts: 3 }
    );
    expect(abandoned!.status).toBe("error");
    expect(abandoned!.error).toMatchObject({ code: "WORKER_CRASHED" });
  });

  it("findStaleRunningExecutionIds finds a backdated running execution", async () => {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
    await repo.claimQueuedExecution(created.id);
    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, created.id));

    const staleIds = await repo.findStaleRunningExecutionIds();
    expect(staleIds).toContain(created.id);
  });

  describe("workspace isolation", () => {
    it("7. userB cannot read an execution belonging to workspace A", async () => {
      const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
        schemaVersion: 1,
        nodes: [],
        edges: [],
        settings: { executionMode: "default" },
      });

      await expect(repo.getExecutionById(userB, workspaceA, created.id)).rejects.toThrow(
        /FORBIDDEN/
      );
    });

    it("8. a user with no membership anywhere cannot read any execution", async () => {
      const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
        schemaVersion: 1,
        nodes: [],
        edges: [],
        settings: { executionMode: "default" },
      });
      const strangerId = crypto.randomUUID();

      await expect(repo.getExecutionById(strangerId, workspaceA, created.id)).rejects.toThrow(
        /FORBIDDEN/
      );
    });

    it("userA can read their own execution normally", async () => {
      const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, {
        schemaVersion: 1,
        nodes: [],
        edges: [],
        settings: { executionMode: "default" },
      });

      const result = await repo.getExecutionById(userA, workspaceA, created.id);
      expect(result?.execution.id).toBe(created.id);
    });
  });
});
