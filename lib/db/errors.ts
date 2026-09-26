/**
 * The SQLSTATE of a database error, or undefined.
 *
 * postgres.js puts it on `err.code`; a wrapping layer may move the original
 * to `err.cause`. Checked in both places so callers never have to know which
 * layer threw. Codes this project relies on:
 *   23503  foreign_key_violation (e.g. RESTRICT on effect history)
 *   WK001  workflow is archived — no new executions (migration 0007)
 *   WK002  workflow has queued/running executions — cannot archive (0007)
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate === "object" && candidate !== null) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}
