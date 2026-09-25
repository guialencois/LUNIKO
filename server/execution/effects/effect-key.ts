import { createHash } from "node:crypto";

/**
 * IDENTITY OF A LOGICAL EXTERNAL OPERATION.
 *
 * The idempotency key is a property of the operation, not the operation
 * itself: it is how the same "send template X to lead 42, in this
 * execution" is recognised as the same thing by every epoch that touches it.
 *
 * It is built from exactly four things, and deliberately from nothing else:
 *
 *   executionId  scopes it to one execution. A second execution — a second
 *                click, or a webhook delivered twice — is a different
 *                operation. Deduplicating those is trigger-level work, a
 *                different layer, and must not be smuggled in here.
 *   nodeId       which step of the workflow.
 *   businessKey  WHICH ENTITY. Mandatory, never an item index.
 *   operation    what kind of action.
 *
 * NEVER from: the claim epoch, claim_attempts, a timestamp, or a random id.
 * Any of those would change between attempts, and a key that changes between
 * attempts identifies the attempt instead of the operation — which is the
 * exact opposite of its job.
 *
 * WHY NOT THE ITEM INDEX, EVEN AS A FALLBACK
 * After a reclaim the worker re-runs the plan from the start, so every node
 * upstream of the effect runs again. Today they are all deterministic and
 * item 3 is always the same entity. The first non-deterministic node
 * upstream — an AI step, an HTTP read, anything that looks at the clock —
 * can reorder or resize the list, and "item 3" then points at a different
 * customer under the same key. Nothing would fail; the wrong person would
 * be affected. So the node has to say which entity it acts on.
 */

export const EFFECT_KEY_VERSION = "v1";
export const BUSINESS_KEY_MAX_LENGTH = 256;
export const OPERATION_MAX_LENGTH = 128;

export class EffectIdentityError extends Error {
  code: "BUSINESS_KEY_REQUIRED" | "INVALID_OPERATION" | "PAYLOAD_NOT_JSON";
  constructor(code: EffectIdentityError["code"], message: string) {
    super(message);
    this.name = "EffectIdentityError";
    this.code = code;
  }
}

// Control characters make keys that look identical in logs but are not.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validates, never normalises. Trimming or case-folding would make two
 * different strings the same identity silently; rejecting keeps the rule
 * explicit and identical across every epoch.
 */
export function validateBusinessKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EffectIdentityError(
      "BUSINESS_KEY_REQUIRED",
      "An external effect needs a businessKey identifying the entity it affects"
    );
  }
  if (value.length > BUSINESS_KEY_MAX_LENGTH) {
    throw new EffectIdentityError(
      "BUSINESS_KEY_REQUIRED",
      `businessKey exceeds ${BUSINESS_KEY_MAX_LENGTH} characters`
    );
  }
  if (value !== value.trim() || CONTROL_CHARS.test(value)) {
    throw new EffectIdentityError(
      "BUSINESS_KEY_REQUIRED",
      "businessKey must not have surrounding whitespace or control characters"
    );
  }
  return value;
}

export function validateOperation(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > OPERATION_MAX_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARS.test(value)
  ) {
    throw new EffectIdentityError("INVALID_OPERATION", "operation must be a short, non-empty identifier");
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted at every depth, arrays in order.
 * `JSON.stringify` preserves insertion order, so the same logical payload
 * built in a different order would hash differently between epochs.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null) return "null";

  if (typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new EffectIdentityError("PAYLOAD_NOT_JSON", "payload contains a non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
    }
    default:
      throw new EffectIdentityError("PAYLOAD_NOT_JSON", `payload contains a ${typeof value}`);
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface EffectIdentityInput {
  executionId: string;
  nodeId: string;
  businessKey: string;
  operation: string;
}

/**
 * The stable key. Hashed over an ordered TUPLE rather than a joined string:
 * joining with a separator lets ("a:b", "c") and ("a", "b:c") collide.
 */
export function deriveIdempotencyKey(input: EffectIdentityInput): string {
  return sha256Hex(
    canonicalJson([
      EFFECT_KEY_VERSION,
      input.executionId,
      input.nodeId,
      validateBusinessKey(input.businessKey),
      validateOperation(input.operation),
    ])
  );
}

/** Hash of the non-secret payload. The payload itself is never stored. */
export function fingerprintPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload ?? {}));
}
