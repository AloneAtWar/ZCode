// 配对证明：proof = base64url_nopad(HMAC-SHA256(key: utf8(passHash),
// msg: utf8(`${nonce}|${role}|${deviceSid}`)))。
// 参照 ZLinker lib/protocol/proof.dart；用 WebCrypto 以同时支持浏览器与 Node 22+。

export type RelayRole = "terminal";

export async function calculatePairingProof(params: {
  passHash: string;
  nonce: string;
  role: RelayRole;
  deviceSid: string;
}): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto subtle 不可用，无法计算配对证明");
  }
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(params.passHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${params.nonce}|${params.role}|${params.deviceSid}`),
  );
  return base64UrlNoPad(new Uint8Array(signature));
}

function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
