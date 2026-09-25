import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export async function GET() {
  let databaseStatus: "ok" | "error" = "ok";

  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    databaseStatus = "error";
  }

  const overallStatus = databaseStatus === "ok" ? "ok" : "degraded";

  return NextResponse.json(
    {
      status: overallStatus,
      services: {
        database: databaseStatus,
      },
    },
    { status: overallStatus === "ok" ? 200 : 503 }
  );
}
