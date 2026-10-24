import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { receiveWebhook } from "@/server/webhooks/receive-webhook";

/**
 * Fase 5A — a URL pública de um Webhook Trigger. Ver docs/webhook-trigger.md.
 *
 * Fina de propósito: lê a request e entrega para receiveWebhook, que decide
 * tudo. Nada de sessão aqui — a credencial é o token no caminho.
 */

export const runtime = "nodejs"; // postgres.js e node:crypto
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

interface RouteParams {
  params: { token: string };
}

async function handle(request: NextRequest, { params }: RouteParams) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return apiError("PAYLOAD_TOO_LARGE", "Request body is too large", 413);
  }
  // Corpo BRUTO: a assinatura da Meta é sobre os bytes exatos que chegaram.
  const rawBody = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return apiError("PAYLOAD_TOO_LARGE", "Request body is too large", 413);
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });

  const result = await receiveWebhook(params.token, {
    method: request.method,
    query: Object.fromEntries(request.nextUrl.searchParams),
    headers,
    rawBody,
    signature: request.headers.get("x-hub-signature-256"),
  });

  if (result.contentType === "text/plain") {
    return new NextResponse(String(result.body), {
      status: result.status,
      headers: { "content-type": "text/plain" },
    });
  }
  return NextResponse.json(result.body, { status: result.status });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
