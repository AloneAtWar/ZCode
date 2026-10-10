// CRC-32（IEEE 多项式），与 relay rpc-frame 的 checksum 字段对应。
// 参照 ZLinker lib/protocol/crc32.dart 的行为移植；纯计算、无平台依赖。

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Hex(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}
