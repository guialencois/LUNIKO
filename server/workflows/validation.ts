import {
  createWorkflowRequestSchema,
  updateWorkflowRequestSchema,
} from "@/lib/workflows/schema";

export class WorkflowValidationError extends Error {
  issues: unknown;
  constructor(message: string, issues: unknown) {
    super(message);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

/**
 * Validates a raw create-workflow request body. Never trust the client's
 * own `workflowSchema.parse(...)` call in the editor — this is the server
 * doing its own, independent validation (item 49 do prompt mestre).
 */
export function validateCreateWorkflowInput(body: unknown) {
  const result = createWorkflowRequestSchema.safeParse(body);
  if (!result.success) {
    throw new WorkflowValidationError(
      "Invalid workflow creation request",
      result.error.flatten()
    );
  }
  return result.data;
}

export function validateUpdateWorkflowInput(body: unknown) {
  const result = updateWorkflowRequestSchema.safeParse(body);
  if (!result.success) {
    throw new WorkflowValidationError(
      "Invalid workflow update request",
      result.error.flatten()
    );
  }
  return result.data;
}
