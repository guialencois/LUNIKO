import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

/**
 * Authorization for the internal endpoints the scheduler invokes (the
 * worker and the reaper). These routes run privileged work with no user
 * session behind them, so they cannot use the normal auth path — and they
 * must never be reachable without a credential.
 *
 * FAIL CLOSED. When CRON_SECRET is unset the answer is "not_configured"
 * and the caller refuses the request. There is deliberately no mode in
 * which a missing secret means "allow": a deployment that forgets the
 * variable gets endpoints that do nothing, never endpoints anyone can call.
 *
 * The comparison hashes both sides first and then compares the fixed-size
 * digests with timingSafeEqual. Comparing the raw strings would either
 * throw or return early on a length mismatch, which leaks the secret's
 * length; digests are always 32 bytes, so neither the length nor the
 * content of the presented value changes how long the check takes.
 */

export type SchedulerAuthResult =
  | { ok: true }
  /** CRON_SECRET is not set: the endpoint is disabled, not open. */
  | { ok: false; reason: "not_configured" }
  /** A credential was presented and it was wrong, or none was presented. */
  | { ok: false; reason: "unauthorized" };

const BEARER = "Bearer ";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function authorizeSchedulerRequest(request: Request): SchedulerAuthResult {
  const secret = serverEnv.CRON_SECRET;
  if (!secret) return { ok: false, reason: "not_configured" };

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith(BEARER)) {
    return { ok: false, reason: "unauthorized" };
  }

  const presented = header.slice(BEARER.length);
  return timingSafeEqual(sha256(presented), sha256(secret))
    ? { ok: true }
    : { ok: false, reason: "unauthorized" };
}
