// rpc-frame 分片传输：逻辑消息 ↔ relay data payload。
// 参照 ZLinker lib/protocol/rpc_transport.dart。
//
// 关键纪律（PoC 实证）：rpc-frame 与 rpc-frame-ack 都必须携带完整 identity
// （bridgeSessionId + bridgeGeneration + 可选 recoveryId）；缺 bridgeGeneration 的
// ack 会被桌面端忽略，触发消息重传，最终以 bridge-degraded: rpc-transport-fault 拆桥。

import { crc32Hex } from "./crc32.js";

const FRAGMENT_PAYLOAD_BYTES = 512 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_FRAGMENTS = 64;
const ASSEMBLY_STALE_MS = 60_000;
const ASSEMBLY_SWEEP_MS = 30_000;

export interface RpcFrameIdentity {
  readonly bridgeSessionId: string;
  readonly bridgeGeneration?: number;
  readonly recoveryId?: string;
}

interface Assembly {
  readonly fragmentCount: number;
  readonly checksum: string | null;
  readonly fragments: (Uint8Array | null)[];
  readonly createdAt: number;
  received: number;
}

export class RpcFrameTransport {
  private seq = 0;
  private messageSeq = 0;
  private readonly assemblies = new Map<number, Assembly>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private onMessageHandler: ((message: Uint8Array) => void) | null = null;

  constructor(
    private readonly identity: RpcFrameIdentity,
    private readonly sendPayload: (payload: Record<string, unknown>) => void,
    private readonly onLog?: (line: string) => void,
  ) {
    this.sweepTimer = setInterval(() => this.purgeStaleAssemblies(), ASSEMBLY_SWEEP_MS);
  }

  get bridgeSessionId(): string {
    return this.identity.bridgeSessionId;
  }

  set onMessage(handler: ((message: Uint8Array) => void) | null) {
    this.onMessageHandler = handler;
  }

  private identityFields(): Record<string, unknown> {
    return {
      bridgeSessionId: this.identity.bridgeSessionId,
      ...(this.identity.bridgeGeneration != null
        ? { bridgeGeneration: this.identity.bridgeGeneration }
        : {}),
      ...(this.identity.recoveryId != null ? { recoveryId: this.identity.recoveryId } : {}),
    };
  }

  /** 分片并发送一条逻辑消息。 */
  sendMessage(bytes: Uint8Array): void {
    if (bytes.length === 0) throw new Error("remote.rpcFrame.emptyMessage");
    if (bytes.length > MAX_MESSAGE_BYTES) throw new Error("remote.rpcFrame.messageTooLarge");
    const messageSeq = ++this.messageSeq;
    const checksum = crc32Hex(bytes);
    const fragmentCount = Math.ceil(bytes.length / FRAGMENT_PAYLOAD_BYTES);
    if (fragmentCount > MAX_FRAGMENTS) throw new Error("remote.rpcFrame.fragmentLimitExceeded");
    for (let i = 0; i < fragmentCount; i++) {
      const chunk = bytes.subarray(i * FRAGMENT_PAYLOAD_BYTES, (i + 1) * FRAGMENT_PAYLOAD_BYTES);
      this.sendPayload({
        zcode_type: "rpc-frame",
        ...this.identityFields(),
        seq: ++this.seq,
        messageSeq,
        fragmentIndex: i,
        fragmentCount,
        messageBytes: bytes.length,
        checksum: { algorithm: "crc32", value: checksum },
        dataBase64: base64Encode(chunk),
      });
    }
  }

  /** 消费 relay payload；返回 true 表示属于本层。 */
  acceptPayload(payload: Record<string, unknown>): boolean {
    const type = payload["zcode_type"];
    if (type === "rpc-frame-ack") return true;
    if (type !== "rpc-frame") return false;
    if (payload["bridgeSessionId"] !== this.identity.bridgeSessionId) return false;

    const messageSeq = toInt(payload["messageSeq"]);
    const fragmentIndex = toInt(payload["fragmentIndex"]);
    const fragmentCount = toInt(payload["fragmentCount"]);
    const dataBase64 = payload["dataBase64"];
    if (
      messageSeq == null ||
      fragmentIndex == null ||
      fragmentCount == null ||
      typeof dataBase64 !== "string"
    ) {
      return true;
    }
    const checksumValue = payload["checksum"];
    const checksum =
      typeof checksumValue === "object" && checksumValue !== null
        ? ((checksumValue as Record<string, unknown>)["value"] as string | undefined)
        : undefined;

    let assembly = this.assemblies.get(messageSeq);
    if (!assembly) {
      assembly = {
        fragmentCount,
        checksum: checksum ?? null,
        fragments: Array.from({ length: fragmentCount }, () => null as Uint8Array | null),
        createdAt: Date.now(),
        received: 0,
      };
      this.assemblies.set(messageSeq, assembly);
    }
    let chunk: Uint8Array;
    try {
      chunk = base64Decode(dataBase64);
    } catch {
      return true;
    }
    if (fragmentIndex >= 0 && fragmentIndex < assembly.fragmentCount) {
      if (!assembly.fragments[fragmentIndex]) assembly.received += 1;
      assembly.fragments[fragmentIndex] = chunk;
    }
    if (assembly.received === assembly.fragmentCount) {
      this.assemblies.delete(messageSeq);
      const message = concatBytes(assembly.fragments);
      if (!assembly.checksum || crc32Hex(message) === assembly.checksum) {
        this.onMessageHandler?.(message);
        this.sendPayload({
          zcode_type: "rpc-frame-ack",
          ...this.identityFields(),
          ackMessageSeq: messageSeq,
        });
      } else {
        this.onLog?.(`[rpc-frame] message ${messageSeq} checksum mismatch`);
      }
    }
    return true;
  }

  private purgeStaleAssemblies(): void {
    const now = Date.now();
    for (const [seq, assembly] of this.assemblies) {
      if (now - assembly.createdAt > ASSEMBLY_STALE_MS) {
        this.assemblies.delete(seq);
      }
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.assemblies.clear();
    this.onMessageHandler = null;
  }
}

function toInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function concatBytes(parts: (Uint8Array | null)[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part?.length ?? 0;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    if (part) {
      out.set(part, offset);
      offset += part.length;
    }
  }
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
