import { z } from "zod";

/**
 * Every environment variable the app needs, validated eagerly so a missing
 * or malformed value fails fast at build/startup time instead of at request
 * time deep inside a handler.
 *
 * NEVER put secrets behind NEXT_PUBLIC_ — anything with that prefix is
 * bundled into client-side JavaScript.
 */
const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
  /**
   * Shared secret for the scheduler-invoked internal endpoints (worker,
   * reaper). Optional ON PURPOSE: making it required would stop the whole
   * app from booting anywhere it isn't set, including local development
   * where nothing schedules anything. The endpoints themselves fail closed
   * when it is absent — they refuse every request rather than running
   * unauthenticated — so "unset" means "internal endpoints disabled",
   * never "internal endpoints open".
   */
  CRON_SECRET: z.string().min(32, "CRON_SECRET must be at least 32 characters").optional(),
  /**
   * WhatsApp (Meta) origin of the Webhook Trigger (docs/webhook-trigger.md). Optional for the
   * same reason as CRON_SECRET: unset means the webhook refuses everything,
   * never that it is open. VERIFY_TOKEN is a value WE choose and type into
   * the Meta panel; APP_SECRET comes from Meta (App settings > Basic).
   */
  WHATSAPP_VERIFY_TOKEN: z.string().min(16, "WHATSAPP_VERIFY_TOKEN must be at least 16 characters").optional(),
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
});

const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

export const publicEnv = publicEnvSchema.parse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

// Only parse server-only secrets when actually running on the server.
// Importing this file from a client component would otherwise throw.
export const serverEnv =
  typeof window === "undefined"
    ? serverEnvSchema.parse({
        DATABASE_URL: process.env.DATABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
        WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
        WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
      })
    : (undefined as never);
