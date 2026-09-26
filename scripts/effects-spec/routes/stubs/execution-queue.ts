// Only the error type the route catches (the queue itself needs the database).
export class QueueError extends Error {
  code: "EXECUTION_NOT_FOUND" | "EXECUTION_NOT_QUEUEABLE";
  constructor(code: "EXECUTION_NOT_FOUND" | "EXECUTION_NOT_QUEUEABLE", message: string) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}
