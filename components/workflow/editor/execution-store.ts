import { create } from "zustand";
import type { NodeOutput, ExecutionError, ExecutionStatus } from "@/lib/execution/types";

/**
 * Deliberately a separate Zustand store from useWorkflowEditorStore
 * (workflow-editor-store.ts). Execution state is not part of the
 * WorkflowDocument and must never be written into it or into the editor
 * store — this store never imports or touches useWorkflowEditorStore, and
 * nothing in useWorkflowEditorStore ever reads execution results.
 *
 * TWO PATHS, AND THE SYNCHRONOUS ONE IS UNCHANGED.
 *
 *   execute()       POST without a mode -> the API runs the workflow inside
 *                   the request and answers with the result. Byte for byte
 *                   the behaviour this store has always had; the button
 *                   still calls exactly this.
 *
 *   executeAsync()  POST mode:"async" -> 202 { executionId, status:"queued" }
 *                   then poll GET /api/executions/[id] until terminal.
 *                   Not wired to any control yet, on purpose: there is no
 *                   UI for choosing a mode in this phase, and inventing one
 *                   would be a redesign. This exists so the moment the mode
 *                   is exposed, the client half already works.
 */

export type ExecutionUIStatus = "idle" | "running" | ExecutionStatus;

interface ExecutionApiErrorBody {
  code: string;
  message: string;
  nodeId?: string;
}

/**
 * Polling bounds. A browser tab must never be left spinning forever
 * because a worker never picked the job up — and with the consumer being a
 * scheduled function, "never picked up" is a real state, not a hypothetical
 * one. MAX_ATTEMPTS * INTERVAL_MS is the ceiling after which the UI stops
 * asking and says so.
 */
const POLL = {
  INTERVAL_MS: 1_000,
  MAX_ATTEMPTS: 150, // ~2.5 minutes
} as const;

/**
 * Generation counter, module-scoped rather than in the store because it is
 * control flow, not rendered state. Every new run — and every reset or
 * panel close — invalidates any poll loop still in flight, so a stale
 * response from an abandoned execution can never write over a newer one.
 */
let pollGeneration = 0;

const TERMINAL: ReadonlySet<string> = new Set(["success", "error", "cancelled"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExecutionUIState {
  status: ExecutionUIStatus;
  executionId: string | null;
  result: NodeOutput | null;
  error: ExecutionApiErrorBody | null;
  isPanelOpen: boolean;

  execute: (workflowId: string) => Promise<void>;
  executeAsync: (workflowId: string) => Promise<void>;
  closePanel: () => void;
  reset: () => void;
}

export const useExecutionStore = create<ExecutionUIState>((set, get) => ({
  status: "idle",
  executionId: null,
  result: null,
  error: null,
  isPanelOpen: false,

  execute: async (workflowId: string) => {
    // Any in-flight async poll belongs to an older run.
    pollGeneration++;

    set({
      status: "running",
      executionId: null,
      result: null,
      error: null,
      isPanelOpen: true,
    });

    let response: Response;
    try {
      // No `input` in the body: the API already defaults it, and this
      // minimal UI has no input-authoring surface (item 3 — not duplicating
      // any logic the API already has). The workflow that actually runs is
      // whatever is persisted server-side, not the in-memory canvas — the
      // button UI is responsible for warning about that (see
      // execution-button.tsx), not this store.
      response = await fetch(`/api/workflows/${workflowId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch {
      set({
        status: "error",
        error: { code: "NETWORK_ERROR", message: "Could not reach the server. Check your connection." },
      });
      return;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      set({
        status: "error",
        error: { code: "INVALID_RESPONSE", message: "The server returned an unexpected response." },
      });
      return;
    }

    if (!response.ok) {
      // Request-level failures: 401/400/404/500 — apiError() shape is
      // {error:{code,message,requestId}}.
      const errorBody = isPlainObject(body) && isPlainObject(body.error) ? body.error : null;
      set({
        status: "error",
        error: {
          code: typeof errorBody?.code === "string" ? errorBody.code : "REQUEST_FAILED",
          message:
            typeof errorBody?.message === "string"
              ? errorBody.message
              : `Request failed with status ${response.status}`,
        },
      });
      return;
    }

    // 200 OK: body is ExecutionApiResponse — but it came over the network,
    // so validate its shape defensively rather than trusting it blindly.
    if (
      !isPlainObject(body) ||
      typeof body.executionId !== "string" ||
      typeof body.status !== "string" ||
      !["success", "error", "cancelled"].includes(body.status)
    ) {
      set({
        status: "error",
        error: { code: "INVALID_RESPONSE", message: "The server returned an unexpected response." },
      });
      return;
    }

    if (body.status === "success") {
      set({
        status: "success",
        executionId: body.executionId,
        result: isPlainObject(body.result) ? (body.result as unknown as NodeOutput) : null,
      });
      return;
    }

    // "error" or "cancelled"
    const errorBody = isPlainObject(body.error) ? (body.error as unknown as ExecutionError) : null;
    set({
      status: body.status as "error" | "cancelled",
      executionId: body.executionId,
      error: errorBody
        ? { code: errorBody.code, message: errorBody.message, nodeId: errorBody.nodeId }
        : { code: "UNKNOWN_ERROR", message: "Execution failed with no error detail." },
    });
  },

  executeAsync: async (workflowId: string) => {
    const generation = ++pollGeneration;
    const superseded = () => generation !== pollGeneration;

    set({
      status: "queued",
      executionId: null,
      result: null,
      error: null,
      isPanelOpen: true,
    });

    const fail = (code: string, message: string) => {
      if (superseded()) return;
      set({ status: "error", error: { code, message } });
    };

    let response: Response;
    try {
      response = await fetch(`/api/workflows/${workflowId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `input` is intentionally absent: the API rejects it with
        // mode:"async" because the queue job carries only the executionId.
        body: JSON.stringify({ mode: "async" }),
      });
    } catch {
      fail("NETWORK_ERROR", "Could not reach the server. Check your connection.");
      return;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      fail("INVALID_RESPONSE", "The server returned an unexpected response.");
      return;
    }

    if (!response.ok) {
      const errorBody = isPlainObject(body) && isPlainObject(body.error) ? body.error : null;
      fail(
        typeof errorBody?.code === "string" ? errorBody.code : "REQUEST_FAILED",
        typeof errorBody?.message === "string"
          ? errorBody.message
          : `Request failed with status ${response.status}`
      );
      return;
    }

    if (!isPlainObject(body) || typeof body.executionId !== "string" || body.status !== "queued") {
      fail("INVALID_RESPONSE", "The server returned an unexpected response.");
      return;
    }

    const executionId = body.executionId;
    if (superseded()) return;
    set({ status: "queued", executionId });

    for (let attempt = 0; attempt < POLL.MAX_ATTEMPTS; attempt++) {
      await sleep(POLL.INTERVAL_MS);
      if (superseded()) return;

      let detailResponse: Response;
      try {
        detailResponse = await fetch(`/api/executions/${executionId}`);
      } catch {
        // A single failed poll is not a failed execution — the run may be
        // perfectly healthy on the server. Keep polling; the attempt cap is
        // what eventually gives up.
        continue;
      }

      if (detailResponse.status === 404) {
        fail("EXECUTION_NOT_FOUND", "This execution could not be found.");
        return;
      }
      if (!detailResponse.ok) continue;

      let detail: unknown;
      try {
        detail = await detailResponse.json();
      } catch {
        continue;
      }
      if (superseded()) return;

      if (!isPlainObject(detail) || typeof detail.status !== "string") continue;

      if (!TERMINAL.has(detail.status)) {
        // "queued" -> "running" is a real transition worth showing.
        set({ status: detail.status as ExecutionUIStatus, executionId });
        continue;
      }

      if (detail.status === "success") {
        set({
          status: "success",
          executionId,
          result: isPlainObject(detail.result) ? (detail.result as unknown as NodeOutput) : null,
        });
        return;
      }

      const errorBody = isPlainObject(detail.error) ? (detail.error as unknown as ExecutionError) : null;
      set({
        status: detail.status as "error" | "cancelled",
        executionId,
        error: errorBody
          ? { code: errorBody.code, message: errorBody.message, nodeId: errorBody.nodeId }
          : { code: "UNKNOWN_ERROR", message: "Execution failed with no error detail." },
      });
      return;
    }

    // Ran out of attempts. The execution itself may still be queued or
    // running server-side — this says the UI stopped watching, not that
    // the run failed, and the id stays on screen so it can be looked up.
    if (superseded()) return;
    set({
      status: "error",
      executionId: get().executionId,
      error: {
        code: "POLL_TIMEOUT",
        message: "Stopped waiting for this execution. It may still be running.",
      },
    });
  },

  // Closing the panel also abandons any poll in flight: nothing is showing
  // its result any more, so continuing to ask would be pure background
  // traffic.
  closePanel: () => {
    pollGeneration++;
    set({ isPanelOpen: false });
  },

  reset: () => {
    pollGeneration++;
    set({ status: "idle", executionId: null, result: null, error: null, isPanelOpen: false });
  },
}));
