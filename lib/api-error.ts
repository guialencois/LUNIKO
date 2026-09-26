import { NextResponse } from "next/server";

export function apiError(
  code: string,
  message: string,
  status: number,
  requestId?: string
) {
  return NextResponse.json(
    { error: { code, message, requestId: requestId ?? crypto.randomUUID() } },
    { status }
  );
}
