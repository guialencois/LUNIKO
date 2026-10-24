import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A Meta assina cada POST do webhook com HMAC-SHA256 do corpo BRUTO, usando
 * o App Secret do app, e manda no cabeçalho `X-Hub-Signature-256` como
 * `sha256=<hex>`. Sem conferir isto, qualquer pessoa que descobrir a URL
 * consegue inserir mensagens falsas no banco.
 *
 * Tem que ser o corpo exatamente como chegou (request.text()), nunca um
 * JSON.stringify do objeto já parseado: qualquer diferença de espaço ou de
 * escape muda o hash.
 */
const PREFIX = "sha256=";

export function isValidMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(PREFIX)) return false;

  const presentedHex = signatureHeader.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(presentedHex)) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const presented = Buffer.from(presentedHex, "hex");
  // Ambos têm 32 bytes aqui (o regex acima garante), então timingSafeEqual
  // não lança e não vaza nada pelo tempo.
  return timingSafeEqual(expected, presented);
}
