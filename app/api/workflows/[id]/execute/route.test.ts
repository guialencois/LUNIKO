import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ExecutionEngineError, ExecutionErrorCode } from "@/lib/execution/errors";

// Mock every boundary the route talks to, so this test exercises only the
// route's own control flow (auth check -> workspace derivation -> body
// validation -> executeWorkflow -> response shaping), not Supabase, Drizzle,
// or the engine itself (those are covered by their own unit/integration
// tests elsewhere).
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/auth/actions", () => ({
  ensureDefaultWorkspace: vi.fn(),
}));
vi.mock("@/server/execution/execute-workflow", () => ({
  executeWorkflow: vi.fn(),
}));
vi.mock("@/server/execution/enqueue-workflow-execution", () => ({
  enqueueWorkflowExecution: vi.fn(),
}));

import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { executeWorkflow } from "@/server/execution/execute-workflow";
import { enqueueWorkflowExecution } from "@/server/execution/enqueue-workflow-execution";
import { POST } from "./route";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockEnsureDefaultWorkspace = vi.mocked(ensureDefaultWorkspace);
const mockExecuteWorkflow = vi.mocked(executeWorkflow);
const mockEnqueueWorkflowExecution = vi.mocked(enqueueWorkflowExecution);

function makeRequest(body?: unknown, raw?: string) {
  return new NextRequest("http://localhost/api/workflows/wf-1/execute", {
    method: "POST",
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

const ROUTE_PARAMS = { params: { id: "wf-1" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/workflows/[id]/execute", () => {
  it("1. rejects an unauthenticated request with 401, never calling executeWorkflow", async () => {
    mockGetCurrentUser.mockResolvedValue(null as never);

    const response = await POST(makeRequest({ input: { items: [{ json: {} }] } }), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error.code).toBe("UNAUTHENTICATED");
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it("2. returns 404 when the workflow doesn't exist", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
    mockExecuteWorkflow.mockRejectedValue(
      new ExecutionEngineError(ExecutionErrorCode.WORKFLOW_NOT_FOUND, "This workflow could not be found")
    );

    const response = await POST(makeRequest({}), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error.code).toBe("WORKFLOW_NOT_FOUND");
  });

  it("3. a workflow belonging to another workspace is rejected the same way (not found, not leaked)", async () => {
    // The route never reads workspaceId from the client at all — it always
    // uses what ensureDefaultWorkspace(user.id) resolves to. A workflow in
    // a workspace the user isn't in simply isn't found by executeWorkflow's
    // own getWorkflowById (workspace-scoped query), which is exactly what
    // we simulate here.
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
    mockExecuteWorkflow.mockRejectedValue(
      new ExecutionEngineError(ExecutionErrorCode.WORKFLOW_NOT_FOUND, "This workflow could not be found")
    );

    // Try to smuggle a workspaceId in the body — it must be ignored.
    const response = await POST(
      makeRequest({ workspaceId: "someone-elses-workspace", input: { items: [{ json: {} }] } }),
      ROUTE_PARAMS
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    const firstCall = mockExecuteWorkflow.mock.calls[0];
    if (!firstCall) throw new Error("executeWorkflow não foi chamado");
    const callArgs = firstCall[0];
    expect(callArgs.workspaceId).toBe("ws-1"); // never "someone-elses-workspace"
    expect(json.error.code).toBe("WORKFLOW_NOT_FOUND");
  });

  it("4a. rejects malformed JSON with 400 INVALID_JSON", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");

    const response = await POST(makeRequest(undefined, "{not valid json"), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it("4b. rejects a body that doesn't match the schema with 400 VALIDATION_ERROR", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");

    const response = await POST(makeRequest({ input: { items: "not-an-array" } }), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it("5. rejects an input over the item-count limit with 400 VALIDATION_ERROR", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");

    const tooManyItems = Array.from({ length: 1001 }, () => ({ json: {} }));
    const response = await POST(
      makeRequest({ input: { items: tooManyItems } }),
      ROUTE_PARAMS
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it("6. returns 200 with status \"error\" when the workflow document itself is invalid", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
    mockExecuteWorkflow.mockResolvedValue({
      executionId: "exec-1",
      status: "error",
      error: { code: "WORKFLOW_INVALID", message: "Workflow document failed validation" },
    });

    const response = await POST(makeRequest({}), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("error");
    expect(json.error.code).toBe("WORKFLOW_INVALID");
  });

  it("7. returns 200 with status \"success\" and a result on a successful execution", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
    mockExecuteWorkflow.mockResolvedValue({
      executionId: "exec-1",
      status: "success",
      result: { items: [{ json: { name: "Jackson" } }] },
    });

    const response = await POST(
      makeRequest({ input: { items: [{ json: { name: "Jackson" } }] } }),
      ROUTE_PARAMS
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      executionId: "exec-1",
      status: "success",
      result: { items: [{ json: { name: "Jackson" } }] },
    });
  });

  it("8. returns 200 with status \"error\" when a node fails during execution", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
    mockExecuteWorkflow.mockResolvedValue({
      executionId: "exec-1",
      status: "error",
      error: { code: "NODE_EXECUTION_FAILED", message: "Node failed", nodeId: "n1" },
    });

    const response = await POST(makeRequest({}), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("error");
    expect(json.error.code).toBe("NODE_EXECUTION_FAILED");
    expect(json.error.nodeId).toBe("n1");
  });

  it("9. returns 200 with status \"error\" and code NOT_IMPLEMENTED for an unsupported executor", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
    mockExecuteWorkflow.mockResolvedValue({
      executionId: "exec-1",
      status: "error",
      error: {
        code: "NOT_IMPLEMENTED",
        message: "HTTP Request execution is not available in this execution environment yet",
        nodeId: "h1",
      },
    });

    const response = await POST(makeRequest({}), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("never leaks a stack trace or internal detail on an unexpected error", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
    mockExecuteWorkflow.mockRejectedValue(new Error("some internal db connection string leak"));

    const response = await POST(makeRequest({}), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe("EXECUTION_FAILED");
    expect(JSON.stringify(json)).not.toContain("connection string");
  });

  // ------------------------------------------------------------------
  // Fase 4H: mode "async". The producer side of the queue. Everything
  // below asserts the same thing from different angles — this branch must
  // never run the workflow during the request.
  // ------------------------------------------------------------------

  function authenticate() {
    mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
    mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
  }

  it('10. mode "async" returns 202 with the queued execution and never runs the engine', async () => {
    authenticate();
    mockEnqueueWorkflowExecution.mockResolvedValue({ executionId: "exec-1", status: "queued" });

    const response = await POST(makeRequest({ mode: "async" }), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json).toEqual({ executionId: "exec-1", status: "queued" });
    // The whole point: no synchronous execution happened.
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockEnqueueWorkflowExecution).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      workflowId: "wf-1",
    });
  });

  it("11. the default is still sync: an unchanged body runs the workflow as before", async () => {
    authenticate();
    mockExecuteWorkflow.mockResolvedValue({
      executionId: "exec-2",
      status: "success",
      result: { items: [{ json: { ok: true } }] },
    } as never);

    const response = await POST(makeRequest({}), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("success");
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockEnqueueWorkflowExecution).not.toHaveBeenCalled();
  });

  it('12. rejects input together with mode "async" instead of silently dropping it', async () => {
    authenticate();

    const response = await POST(
      makeRequest({ mode: "async", input: { items: [{ json: { a: 1 } }] } }),
      ROUTE_PARAMS
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(mockEnqueueWorkflowExecution).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it("13. rejects an unknown mode", async () => {
    authenticate();

    const response = await POST(makeRequest({ mode: "eventual" }), ROUTE_PARAMS);

    expect(response.status).toBe(400);
    expect(mockEnqueueWorkflowExecution).not.toHaveBeenCalled();
  });

  it('14. mode "async" maps a missing workflow to the same 404 the sync branch gives', async () => {
    authenticate();
    mockEnqueueWorkflowExecution.mockRejectedValue(
      new ExecutionEngineError(ExecutionErrorCode.WORKFLOW_NOT_FOUND, "This workflow could not be found")
    );

    const response = await POST(makeRequest({ mode: "async" }), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error.code).toBe("WORKFLOW_NOT_FOUND");
  });

  it('15. mode "async" maps an unexecutable document to 400 with its engine code', async () => {
    authenticate();
    mockEnqueueWorkflowExecution.mockRejectedValue(
      new ExecutionEngineError(ExecutionErrorCode.WORKFLOW_CONTAINS_CYCLE, "Workflow contains a cycle")
    );

    const response = await POST(makeRequest({ mode: "async" }), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("WORKFLOW_CONTAINS_CYCLE");
  });

  it("16. an unauthenticated async request is rejected before anything is queued", async () => {
    mockGetCurrentUser.mockResolvedValue(null as never);

    const response = await POST(makeRequest({ mode: "async" }), ROUTE_PARAMS);

    expect(response.status).toBe(401);
    expect(mockEnqueueWorkflowExecution).not.toHaveBeenCalled();
  });

  it("17. (Fase 10.5A) an archived workflow is a 409 WORKFLOW_ARCHIVED, on both paths", async () => {
    authenticate();
    const archived = new ExecutionEngineError(
      ExecutionErrorCode.WORKFLOW_ARCHIVED,
      "This workflow is archived. Restore it before executing it."
    );
    mockExecuteWorkflow.mockRejectedValue(archived);
    mockEnqueueWorkflowExecution.mockRejectedValue(archived);

    for (const body of [{}, { mode: "async" }]) {
      const response = await POST(makeRequest(body), ROUTE_PARAMS);
      const json = await response.json();
      expect(response.status).toBe(409);
      expect(json.error.code).toBe("WORKFLOW_ARCHIVED");
      expect(json.error.message).toMatch(/Restore it/);
    }
  });
});
