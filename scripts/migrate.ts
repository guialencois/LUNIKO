import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import postgres from "postgres";

/**
 * Minimal migration runner: applies every .sql file in db/migrations, in
 * filename order, inside a single transaction each. Tracks applied
 * migrations in a _migrations table so re-running is a no-op.
 *
 * Usage: npm run db:migrate  (requires DATABASE_URL to be set)
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Check your .env file.");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  await sql`
    CREATE TABLE IF NOT EXISTS "_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )
  `;

  const migrationsDir = join(process.cwd(), "db", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const alreadyApplied = await sql`
      SELECT 1 FROM "_migrations" WHERE "name" = ${file}
    `;
    if (alreadyApplied.length > 0) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }

    const content = readFileSync(join(migrationsDir, file), "utf-8");
    console.log(`apply ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO "_migrations" ("name") VALUES (${file})`;
    });
  }

  await sql.end();
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
