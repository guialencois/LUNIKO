import { z } from "zod";
import { EXECUTION_LIMITS } from "@/lib/execution/types";

/**
 * Zod mirror of NodeInput/ExecutionItem (lib/execution/types.ts). Those are
 * TS-only interfaces with no runtime validation of their own — this is the
 * one place that validates a request body against that same shape, reusing
 * the existing EXECUTION_LIMITS constants rather than inventing a second
 * set of limits for "input at the API boundary" vs. "input at a node".
 */
export const executionItemSchema = z.object({
  json: z.record(z.unknown()),
});

export const nodeInputSchema = z
  .object({
    items: z.array(executionItemSchema).max(EXECUTION_LIMITS.MAX_ITEMS_PER_NODE),
  })
  .superRefine((input, ctx) => {
    const size = JSON.stringify(input).length;
    if (size > EXECUTION_LIMITS.MAX_OUTPUT_SIZE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `input is ${size} bytes, exceeding the limit of ${EXECUTION_LIMITS.MAX_OUTPUT_SIZE_BYTES}`,
      });
    }
  });

/**
 * `mode` decides WHICH lifecycle handles the request, and defaults to the
 * one that already existed:
 *
 *   "sync"  (default, unchanged) run the workflow inside this request and
 *           answer with the result. Every existing caller — including the
 *           editor's execution store, which has no polling — keeps exactly
 *           the behaviour and the response shape it has today.
 *
 *   "async" create a queued execution and answer immediately with its id.
 *           Nothing runs during the request.
 *
 * `input` is rejected together with "async" rather than silently dropped:
 * the queue job carries only { executionId } by design
 * (docs/async-execution.md), so the worker starts from the default initial
 * input and has no way to receive a caller-supplied one. Accepting the
 * field and ignoring it would be a silent data loss at the API boundary.
 */
export const executeWorkflowRequestSchema = z
  .object({
    input: nodeInputSchema.optional(),
    mode: z.enum(["sync", "async"]).default("sync"),
  })
  .superRefine((body, ctx) => {
    if (body.mode === "async" && body.input !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input"],
        message:
          'input is not supported with mode "async": the queue job carries only the executionId, so a caller-supplied input cannot reach the worker',
      });
    }
  });

export class ExecuteRequestValidationError extends Error {
  issues: unknown;
  constructor(message: string, issues: unknown) {
    super(message);
    this.name = "ExecuteRequestValidationError";
    this.issues = issues;
  }
}

export function validateExecuteWorkflowRequest(body: unknown) {
  const result = executeWorkflowRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ExecuteRequestValidationError(
      "Invalid execute-workflow request",
      result.error.flatten()
    );
  }
  return result.data;
}
