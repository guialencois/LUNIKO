/**
 * Safe (redacted) representation of a WorkflowDocument — the "B" side of a
 * split this module exists to make explicit:
 *
 *   A) the RUNTIME document — what the planner and the executors actually
 *      read. It must stay byte-for-byte what the user authored. It is
 *      stored intact in executions.document precisely because the
 *      asynchronous path executes that stored row
 *      (process-queued-execution.ts reads claimed.document). Nothing in
 *      this file is ever applied to it.
 *
 *   B) the SAFE representation — a copy produced on the way OUT, for an
 *      API response, an audit view or a log line. Only this side may
 *      contain "[REDACTED]".
 *
 * WHY THIS FILE EXISTS
 * The repository used to redact the document on the way IN, with a regex
 * (/token|password|secret|key|authorization|cookie|credential/i) matched
 * against EVERY property name at EVERY depth. Two things were wrong with
 * that, and only the second one is about security:
 *
 *   1. it corrupted the program before running it. A Set node stores
 *      data.values as a record whose keys the user types in the editor,
 *      so a field named "bookingKey" or "tokenVoucher" was replaced by
 *      "[REDACTED]" in the stored document — and the async worker then
 *      executed that. The same workflow produced different results
 *      depending on whether it ran synchronously or through the queue.
 *
 *   2. it guessed. A property name is not evidence of a secret: the name
 *      space it lives in is. "bookingKey" is a field name a travel agent
 *      typed; "Authorization" is a name defined by RFC 9110. Applying one
 *      rule to both namespaces is what made the heuristic both
 *      destructive and unreliable.
 *
 * So redaction here is targeted, not heuristic: it looks at exactly one
 * place, the one place in this project where a credential is actually
 * authored today — an httpRequest node's `data.headers`, whose keys are
 * HTTP header names (see lib/workflows/definitions/http-request.ts,
 * `headers: z.record(z.string())`). Matching by name IS correct there,
 * because that namespace is defined by the HTTP spec, not by the user.
 *
 * WHEN A REAL SECRETS SYSTEM ARRIVES
 * There is no credential store in this project yet, and this file does not
 * invent one. When one exists (encrypted at rest, referenced by id from a
 * node's config), redaction should target THAT structure explicitly and be
 * extended here — never by widening the name matching back out over
 * arbitrary user data.
 */

/** Replacement written into the safe copy. Never written into a runtime document. */
export const REDACTED = "[REDACTED]";

/**
 * HTTP request headers that carry credentials. Names come from the HTTP
 * specs (RFC 9110 §11, RFC 6265) plus the two de-facto API-key headers,
 * and are compared case-insensitively because header names are
 * case-insensitive. This list is deliberately closed and short: it is not
 * a pattern, and it is not applied outside a headers map.
 */
export const SENSITIVE_HTTP_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
];

const SENSITIVE_HTTP_HEADER_SET = new Set(SENSITIVE_HTTP_HEADERS);

/** True only for a header name the HTTP spec defines as credential-bearing. */
export function isSensitiveHttpHeader(name: string): boolean {
  return SENSITIVE_HTTP_HEADER_SET.has(name.trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural deep copy. A WorkflowDocument is JSON by contract
 * (lib/workflows/types.ts), so this covers every value one can legally
 * hold, and guarantees the caller's object is never reached by the
 * redaction below — no shared references, no mutation of the input.
 */
function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = deepCopy(val);
    return out;
  }
  return value;
}

/**
 * Returns a SAFE COPY of a workflow document for display, audit or logs.
 *
 * Guarantees:
 * - the input is never mutated, and shares no reference with the output;
 * - only `nodes[].data.headers` of nodes whose `type` is "httpRequest" can
 *   change, and only for header names in SENSITIVE_HTTP_HEADERS;
 * - every other node type, every other field, and every user-authored key
 *   (a Set node's data.values, above all) comes back exactly as given;
 * - anything that isn't shaped like a WorkflowDocument is returned as a
 *   plain copy rather than throwing — callers pass `unknown` read back
 *   from jsonb, and a read path must not fail on a malformed row.
 */
export function redactWorkflowDocument(document: unknown): unknown {
  const copy = deepCopy(document);
  if (!isRecord(copy) || !Array.isArray(copy.nodes)) return copy;

  for (const node of copy.nodes) {
    if (!isRecord(node) || node.type !== "httpRequest") continue;
    if (!isRecord(node.data)) continue;

    const headers = node.data.headers;
    if (!isRecord(headers)) continue;

    for (const headerName of Object.keys(headers)) {
      if (isSensitiveHttpHeader(headerName)) headers[headerName] = REDACTED;
    }
  }

  return copy;
}
