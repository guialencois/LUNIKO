import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

/**
 * These tests exercise the real database (workspaces, workspace_members,
 * workflows tables + the queries/mutations that sit on top of them). They
 * require a running Postgres reachable via TEST_DATABASE_URL, with the
 * Phase 1 + Phase 2 migrations already applied (npm run db:migrate).
 *
 * They are skipped — not faked — when that database isn't available, which
 * is the case in the sandbox this project was generated in (no network,
 * no Postgres). Run them for real with:
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("workflow CRUD + workspace authorization (integration)", () => {
  // Dynamic imports so this file doesn't try to open a DB connection at
  // module-load time when the suite is skipped.
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let queries: typeof import("./queries");
  let mutations: typeof import("./mutations");

  let workspaceA: string;
  let workspaceB: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    queries = await import("./queries");
    mutations = await import("./mutations");

    userA = crypto.randomUUID();
    userB = crypto.randomUUID();

    const [wsA] = await db
      .insert(schema.workspaces)
      .values({ name: "Test Workspace A" })
      .returning({ id: schema.workspaces.id });
    const [wsB] = await db
      .insert(schema.workspaces)
      .values({ name: "Test Workspace B" })
      .returning({ id: schema.workspaces.id });
    workspaceA = wsA.id;
    workspaceB = wsB.id;

    await db.insert(schema.workspaceMembers).values([
      { workspaceId: workspaceA, userId: userA, role: "owner" },
      { workspaceId: workspaceB, userId: userB, role: "owner" },
    ]);
  });

  afterAll(async () => {
    if (!hasTestDb) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceB));
  });

  it("creates a workflow scoped to the caller's workspace", async () => {
    const workflow = await mutations.createWorkflow(userA, workspaceA, {
      name: "My workflow",
      description: "",
    });
    expect(workflow.workspaceId).toBe(workspaceA);
    expect(workflow.status).toBe("draft");
    expect(workflow.document).toEqual({
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
  });

  it("lists only workflows belonging to the caller's workspace", async () => {
    await mutations.createWorkflow(userA, workspaceA, { name: "A1", description: "" });
    await mutations.createWorkflow(userB, workspaceB, { name: "B1", description: "" });

    const listA = await queries.listWorkflows(userA, workspaceA);
    expect(listA.every((w: { name: string }) => w.name !== "B1")).toBe(true);
  });

  it("gets a workflow by id within the correct workspace", async () => {
    const created = await mutations.createWorkflow(userA, workspaceA, {
      name: "Gettable",
      description: "",
    });
    const fetched = await queries.getWorkflowById(userA, workspaceA, created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it("updates a workflow's document and bumps updatedAt", async () => {
    const created = await mutations.createWorkflow(userA, workspaceA, {
      name: "Updatable",
      description: "",
    });
    const newDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "manualTrigger", name: "Start", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [],
      settings: { executionMode: "default" as const },
    };

    const updated = await mutations.updateWorkflow(userA, workspaceA, created.id, {
      document: newDocument,
    });

    expect(updated?.document).toEqual(newDocument);
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it("deletes a workflow", async () => {
    const created = await mutations.createWorkflow(userA, workspaceA, {
      name: "Deletable",
      description: "",
    });
    const deleted = await mutations.deleteWorkflow(userA, workspaceA, created.id);
    expect(deleted?.id).toBe(created.id);

    const fetched = await queries.getWorkflowById(userA, workspaceA, created.id);
    expect(fetched).toBeNull();
  });

  describe("cross-workspace isolation", () => {
    it("userB cannot GET a workflow that belongs to workspace A", async () => {
      const created = await mutations.createWorkflow(userA, workspaceA, {
        name: "Belongs to A",
        description: "",
      });

      // userB is not a member of workspaceA at all — requireWorkspaceMembership
      // must reject before the query even runs.
      await expect(queries.getWorkflowById(userB, workspaceA, created.id)).rejects.toThrow(
        /FORBIDDEN/
      );
    });

    it("userB cannot PATCH a workflow that belongs to workspace A", async () => {
      const created = await mutations.createWorkflow(userA, workspaceA, {
        name: "Belongs to A",
        description: "",
      });

      await expect(
        mutations.updateWorkflow(userB, workspaceA, created.id, { name: "Hijacked" })
      ).rejects.toThrow(/FORBIDDEN/);
    });

    it("userB cannot DELETE a workflow that belongs to workspace A", async () => {
      const created = await mutations.createWorkflow(userA, workspaceA, {
        name: "Belongs to A",
        description: "",
      });

      await expect(mutations.deleteWorkflow(userB, workspaceA, created.id)).rejects.toThrow(
        /FORBIDDEN/
      );

      // Confirm it's still there, untouched, from workspace A's perspective.
      const stillThere = await queries.getWorkflowById(userA, workspaceA, created.id);
      expect(stillThere?.id).toBe(created.id);
    });

    it("a workspaceId that doesn't belong to the caller can't be used to reach another workspace's data", async () => {
      const createdInB = await mutations.createWorkflow(userB, workspaceB, {
        name: "Belongs to B",
        description: "",
      });

      // Even if userA somehow supplied workspaceB as the target, they are
      // not a member of it, so the membership check must reject them
      // before the workspaceId filter on the query even matters.
      await expect(queries.getWorkflowById(userA, workspaceB, createdInB.id)).rejects.toThrow(
        /FORBIDDEN/
      );
    });
  });
});
