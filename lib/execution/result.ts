import type { RunPlanOutcome } from "./executor";

export interface ExecutionApiResponse {
  executionId: string;
  status: "success" | "error" | "cancelled";
  result?: { items: { json: Record<string, unknown> }[] };
  error?: { code: string; message: string; nodeId?: string };
}

/** No stack traces, no internal detail beyond code/message/nodeId — item 27
 *  ("Não expor stack traces internos ao cliente em produção"). */
export function buildExecutionApiResponse(
  executionId: string,
  outcome: RunPlanOutcome
): ExecutionApiResponse {
  if (outcome.status === "success") {
    return {
      executionId,
      status: "success",
      result: outcome.finalOutput,
    };
  }

  return {
    executionId,
    status: outcome.status,
    error: outcome.error
      ? {
          code: outcome.error.code,
          message: outcome.error.message,
          nodeId: outcome.error.nodeId,
        }
      : { code: "UNKNOWN_ERROR", message: "Execution failed with no error detail" },
  };
}
