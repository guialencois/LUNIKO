export class WorkflowValidationError extends Error {}
export function validateUpdateWorkflowInput(body: unknown) { return body as { name?: string }; }
export function validateCreateWorkflowInput(body: unknown) { return body as { name: string; description: string }; }
