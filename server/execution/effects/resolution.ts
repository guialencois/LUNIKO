import { z } from "zod";

/**
 * FASE 10.5A — WHAT A PERSON MAY DO WITH AN "unknown" OPERATION.
 *
 * "unknown" means: an attempt crossed the point of no return and nobody
 * knows whether the provider acted. A person can settle that — with
 * evidence, never by preference. The whole contract:
 *
 *   MAY    read it: the operation, its execution and workflow, and every
 *          fact in its history (any member of the workspace);
 *   MAY    resolve it ONCE, as one of three decisions, each tied to what the
 *          PROVIDER shows (owner or admin only):
 *            confirmed_sent      the provider has the effect — needs the
 *                                provider's reference for it
 *            confirmed_not_sent  the provider has no record of it — needs
 *                                what was checked and what it showed
 *            confirmed_rejected  the provider received it and refused it —
 *                                same evidence as above
 *          always with a justification, and the evidence source, which is
 *          the provider itself (API lookup, dashboard, webhook, support) —
 *          "I think so" is not a source;
 *   ONLY   after the execution has ended, and after the cooling period
 *          (below): before that, the call that crossed the point of no
 *          return may still answer on its own.
 *
 *   MAY NOT  pick a state without evidence; resolve anything that is not
 *            "unknown" (an outcome the provider reported is final); resolve
 *            twice, or overwrite another person's resolution; edit or delete
 *            history; send again from here.
 *
 * And the rule that outranks all of this: if the provider's own answer to
 * that call arrives after a person resolved it, the answer replaces the
 * decision, and the history keeps both (recordEffectOutcome). A person
 * resolves the operational state; the provider reports the external fact.
 *
 * Every rule here is also enforced below the API: the migration 0007
 * refuses a `resolved` event without justification/evidence, the guard
 * refuses a person overwriting a person, and only "unknown" can be resolved.
 *
 * WHAT GOES INTO THE HISTORY (LGPD as an engineering rule, not a legal
 * conclusion): only what proves what happened. The `resolved` fact is
 * append-only — nothing typed here can be edited out later — so the
 * justification, the evidence detail and the reference are refused when
 * they look like what must never be stored: an Authorization/Cookie header,
 * a bearer token, a labelled secret (api_key=, password:, ...), a private
 * key, a JWT, or a credential in a known provider format
 * (LOOKS_LIKE_CREDENTIAL — best effort, not a guarantee). Personal data
 * cannot be detected reliably; the limits (1000/500/256 characters) and the
 * guidance in docs/async-execution.md are what keep payloads out: describe
 * what was checked and what it showed — an id, a status, a time — not the
 * message.
 */

export const EFFECT_RESOLUTIONS = ["confirmed_sent", "confirmed_not_sent", "confirmed_rejected"] as const;
export type EffectResolution = (typeof EFFECT_RESOLUTIONS)[number];

export const EVIDENCE_SOURCES = [
  "provider_api",
  "provider_dashboard",
  "provider_webhook",
  "provider_support",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** Who may decide. Reading is open to every member; deciding is not. */
export const RESOLVER_ROLES = ["owner", "admin"] as const;

/**
 * How long after the call began before a person may resolve it.
 *
 * The worker invocation that made the call lives at most `maxDuration`
 * (300s, app/api/internal/worker/route.ts) — while it lives, the call's own
 * answer can still arrive and settle the operation by itself. Twice that is
 * the margin. This covers the CALL's answer only; confirmations a provider
 * sends later on its own (webhooks) are per integration, in its ficha.
 */
export const RESOLUTION_COOLING_PERIOD_SECONDS = 600;

/** Final states of an execution: nothing still runs on its behalf. */
export const TERMINAL_EXECUTION_STATUSES = ["success", "error", "cancelled"] as const;

const JUSTIFICATION_MIN = 10;
const JUSTIFICATION_MAX = 1000;
const EVIDENCE_DETAIL_MIN = 5;
const EVIDENCE_DETAIL_MAX = 500;
const REFERENCE_MAX = 256;

// NUL and unpaired surrogates cannot be stored in PostgreSQL's jsonb/text.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Credentials and headers in the forms they are pasted in — raw, or
 * JSON-quoted as a browser's "Copy as fetch" writes them. A best-effort
 * guard, deliberately narrow: each pattern needs the shape of a secret, not
 * just a word ("authorization: 004512" is a card authorization code and
 * passes; "Authorization: Basic ..." does not). It cannot catch every
 * secret, and it may refuse a rare legitimate text — the operator rewrites
 * it. Runs only on text already known to be within the length limits.
 */
const LOOKS_LIKE_CREDENTIAL: readonly RegExp[] = [
  // an HTTP auth header: the scheme is what makes it a credential
  /\bauthorization["']?\s*[:=]\s*["']?(?:basic|bearer|digest|negotiate|token|apikey)\b/i,
  // a cookie header carrying a name=value pair
  /\b(?:set-)?cookie["']?\s*[:=]\s*["']?[^\s=;"',]+=[^\s;"',]+/i,
  // a bearer token: 20+ token characters with letters and digits
  /\bbearer\s+(?=[\w.~+/=-]*[A-Za-z])(?=[\w.~+/=-]*\d)[\w.~+/=-]{20,}/i,
  // a labelled secret (header, query string, JSON or prose): a value with a
  // digit and 8+ characters, or 16+ characters
  /(?<![A-Za-z0-9])(?:x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|password|passwd|senha|secret|token)["']?\s*[:=]\s*["']?(?:(?=[^\s"',;&]*\d)[^\s"',;&]{8,}|[^\s"',;&]{16,})/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/, // a JWT
  /\b(?:APP_USR|TEST)-\d{6,}-\d{6}-[0-9a-f]{32}-\d+/, // Mercado Pago access token
  /\bEAA[A-Za-z0-9]{30,}/, // Meta (WhatsApp/Facebook) access token
  /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/, // Google OAuth access token
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/, // Stripe secret/restricted key
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/, // GitHub token
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack token
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
];
const CREDENTIAL_MESSAGE =
  "looks like it contains a credential or an HTTP header; describe what was checked, never paste tokens or headers";
const hasCredential = (v: string) => LOOKS_LIKE_CREDENTIAL.some((re) => re.test(v));

/** Length as PostgreSQL's length() counts it — in characters (code
 *  points), not UTF-16 units — so the database's own minimums (0007) can
 *  never refuse what this accepted: "😀😀😀😀😀" is 5 characters, not 10. */
const characters = (v: string) => Array.from(v).length;

/**
 * Free text written by a person, checked in order and stopped at the first
 * problem. Nothing scans a text before its length is known to be within the
 * limit: zod runs every refinement even after one failed, and a pattern run
 * over megabytes is a denial of service (the independent review measured
 * 10 s for 128 KB before this ordering).
 */
const prose = (min: number, max: number) =>
  z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      // A character is 1 or 2 UTF-16 units: more than 2*max units cannot fit.
      const n = v.length > max * 2 ? Number.POSITIVE_INFINITY : characters(v);
      const problem =
        n < min
          ? `must be at least ${min} characters`
          : n > max
            ? `must be at most ${max} characters`
            : UNSTORABLE.test(v)
              ? "contains characters that cannot be stored"
              : hasCredential(v)
                ? CREDENTIAL_MESSAGE
                : null;
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    });

export const resolveEffectRequestSchema = z
  .object({
    resolution: z.enum(EFFECT_RESOLUTIONS),
    // A reference is evidence: taken exactly as given, never trimmed or
    // repaired — only refused when it cannot be one.
    providerReference: z.string().optional(),
    evidence: z
      .object({
        source: z.enum(EVIDENCE_SOURCES),
        detail: prose(1, EVIDENCE_DETAIL_MAX).optional(),
      })
      .strict(),
    justification: prose(JUSTIFICATION_MIN, JUSTIFICATION_MAX),
  })
  .strict()
  .superRefine((body, ctx) => {
    const ref = body.providerReference;
    if (body.resolution === "confirmed_sent") {
      if (ref === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providerReference"],
          message: "confirmed_sent needs the provider's reference for the effect",
        });
      }
    } else {
      // (below 2*MIN units only: a longer text has at least MIN characters)
      const detail = body.evidence.detail ?? "";
      if (detail.length < EVIDENCE_DETAIL_MIN * 2 && characters(detail) < EVIDENCE_DETAIL_MIN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence", "detail"],
          message: `${body.resolution} needs what was checked at the provider and what it showed (at least ${EVIDENCE_DETAIL_MIN} characters)`,
        });
      }
      if (body.resolution === "confirmed_not_sent" && ref !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providerReference"],
          message: "confirmed_not_sent means the provider has no record, so there is no reference to give",
        });
      }
    }
    if (
      ref !== undefined &&
      (ref.length === 0 || ref.length > REFERENCE_MAX || ref !== ref.trim() || CONTROL.test(ref) || UNSTORABLE.test(ref))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerReference"],
        message: `providerReference must be the provider's identifier as shown: 1-${REFERENCE_MAX} printable characters, no surrounding spaces`,
      });
    } else if (ref !== undefined && hasCredential(ref)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerReference"], message: CREDENTIAL_MESSAGE });
    }
  });

export type ResolveEffectInput = z.infer<typeof resolveEffectRequestSchema>;

export class ResolveRequestValidationError extends Error {
  issues: unknown;
  constructor(message: string, issues: unknown) {
    super(message);
    this.name = "ResolveRequestValidationError";
    this.issues = issues;
  }
}

export function validateResolveEffectRequest(body: unknown): ResolveEffectInput {
  const result = resolveEffectRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ResolveRequestValidationError("Invalid resolution request", result.error.flatten());
  }
  return result.data;
}

/** The status a decision puts the operation in. */
export function statusForResolution(resolution: EffectResolution): "succeeded" | "failed" {
  return resolution === "confirmed_sent" ? "succeeded" : "failed";
}
