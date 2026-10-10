// Relay 连接状态机：ws 连接、auth 配对握手、心跳、重连退避、出站队列。
// 参照 ZLinker lib/protocol/relay_client.dart；帧格式与官方 web remote 客户端一致
// （JSON 文本帧，`type` 字段区分 auth_*/data/error/pair_status_*）。

import type { RemoteConnectionParams } from "./connectionParams.js";
import { calculatePairingProof } from "./proof.js";

export type RelayState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "error"
  | "kicked"
  | "closed";

export interface RelayFailure {
  readonly reason: string;
  readonly message?: string;
}

/** relay 关闭码语义（对照官方 web 客户端的映射表）。 */
export function relayCloseReason(code: number): string | null {
  switch (code) {
    case 4004:
      return "session-not-found";
    case 4009:
      return "session-conflict";
    case 4010:
      return "desktop-disconnected";
    case 4011:
      return "session-expired";
    case 4012:
      return "workspace-closed";
    case 4013:
      return "invalid-mobile-connection";
    default:
      return null;
  }
}

export interface RelayClientOptions {
  /** 控制端自报名称，显示在被控端的已连接设备上。 */
  clientName?: string;
  /** 覆盖平台标识（默认按 UA/运行时推断，PoC 用 windows）。 */
  platform?: string;
  onStateChanged?: (state: RelayState) => void;
  /** 所有入站 data payload（已配对后才有业务流量）。 */
  onPayload?: (payload: Record<string, unknown>) => void;
  onFailure?: (failure: RelayFailure) => void;
  /** 调试日志；实现方必须自行避免打印凭据字段。 */
  onLog?: (line: string) => void;
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_ACK_TIMEOUT_MS = 30_000;
const WAITING_TIMEOUT_MS = 30_000;
const REWAIT_TIMEOUT_MS = 20_000;
const MAX_QUEUED_OUTBOUND = 100;

export class RelayClient {
  private socket: WebSocket | null = null;
  private state_: RelayState = "idle";
  private wasPaired = false;
  private intentionallyClosed = false;
  private disposed = false;
  private reconnectAttempt = 0;
  private lastPairStatusAckAt = Date.now();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private waitingTimer: ReturnType<typeof setTimeout> | undefined;
  private rewaitTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly outboundQueue: Record<string, unknown>[] = [];

  constructor(
    private readonly params: RemoteConnectionParams,
    private readonly options: RelayClientOptions = {},
  ) {}

  get state(): RelayState {
    return this.state_;
  }

  get paired(): boolean {
    return this.state_ === "paired";
  }

  private setState(state: RelayState): void {
    this.state_ = state;
    this.options.onStateChanged?.(state);
  }

  private log(line: string): void {
    this.options.onLog?.(line);
  }

  start(): void {
    this.disposed = false;
    this.intentionallyClosed = false;
    this.reconnectAttempt = 0;
    this.setState("connecting");
    this.connectSocket();
  }

  private connectSocket(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.params.relayWsUrl);
    } catch (error) {
      this.handleSocketClosed(1006, String(error));
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.disposed || this.socket !== socket) {
        socket.close();
        return;
      }
      this.setState("authenticating");
      this.sendFrame({
        type: "auth_init",
        role: "terminal",
        device_sid: this.params.deviceSid,
        meta: {
          platform: this.options.platform ?? detectPlatform(),
          version: this.params.appVersion ?? "web",
          name: this.options.clientName ?? "zcode-relay-client",
        },
      });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      const text =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      this.handleRawMessage(text);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket && !this.disposed) return;
      this.handleSocketClosed(event.code, event.reason);
    });
    socket.addEventListener("error", () => {
      // close 事件随后到达，在那里统一处理状态。
    });
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ ...frame, client_ts: Date.now() }));
  }

  /** 业务 payload；未配对时排队，matched 后按序 flush。 */
  sendPayload(payload: Record<string, unknown>): void {
    if (!this.paired || !this.socket) {
      if (this.outboundQueue.length < MAX_QUEUED_OUTBOUND) {
        this.outboundQueue.push(payload);
      }
      return;
    }
    this.sendFrame({ type: "data", payload });
  }

  private flushOutboundQueue(): void {
    const queued = this.outboundQueue.splice(0, this.outboundQueue.length);
    for (const payload of queued) {
      this.sendFrame({ type: "data", payload });
    }
  }

  private handleRawMessage(text: string): void {
    let frame: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(text);
      if (typeof decoded !== "object" || decoded === null || !("type" in decoded)) return;
      frame = decoded as Record<string, unknown>;
    } catch {
      return;
    }
    switch (frame["type"]) {
      case "auth_challenge": {
        const nonce = typeof frame["nonce"] === "string" ? frame["nonce"] : "";
        void calculatePairingProof({
          passHash: this.params.passHash,
          nonce,
          role: "terminal",
          deviceSid: this.params.deviceSid,
        }).then((proof) =>
          this.sendFrame({
            type: "auth_response",
            device_sid: this.params.deviceSid,
            proof,
          }),
        );
        break;
      }
      case "auth_ack":
      case "pair_status_ack":
        this.applyPairStatus(
          typeof frame["pair_status"] === "string" ? frame["pair_status"] : null,
        );
        break;
      case "data": {
        const payload = frame["payload"];
        if (typeof payload === "object" && payload !== null) {
          this.options.onPayload?.(payload as Record<string, unknown>);
        }
        break;
      }
      case "error":
        this.handleRelayError(frame["code"], frame["message"]);
        break;
    }
  }

  private applyPairStatus(status: string | null): void {
    this.lastPairStatusAckAt = Date.now();
    if (status === "waiting") {
      if (this.wasPaired) {
        this.clearWaitingTimers();
        this.setState("waiting");
        this.startHeartbeat();
        // 已配对过的终端重连后应立即被 matched；持续 waiting 说明配对卡住，强制重连。
        this.rewaitTimer = setTimeout(() => {
          if (this.wasPaired && this.state_ === "waiting" && !this.disposed) {
            void this.reconnect();
          }
        }, REWAIT_TIMEOUT_MS);
      } else {
        this.setState("waiting");
        this.startWaitingTimer();
      }
      return;
    }
    if (status === "matched") {
      if (this.rewaitTimer) {
        clearTimeout(this.rewaitTimer);
        this.rewaitTimer = undefined;
      }
      this.reconnectAttempt = 0;
      this.clearWaitingTimers();
      this.setState("paired");
      this.wasPaired = true;
      this.startHeartbeat();
      this.flushOutboundQueue();
    }
  }

  private handleRelayError(code: unknown, message: unknown): void {
    if (code === "KICKED") {
      this.setState("kicked");
      this.intentionallyClosed = true;
      this.options.onFailure?.({
        reason: "kicked",
        ...(typeof message === "string" ? { message } : {}),
      });
      this.socket?.close();
    }
  }

  private handleSocketClosed(code: number, reason: string): void {
    if (this.disposed) return;
    this.stopHeartbeat();
    this.clearWaitingTimers();
    const mapped = relayCloseReason(code);
    this.log(`closed code=${code} reason=${reason} mapped=${mapped ?? "-"}`);
    if (this.intentionallyClosed) return;
    if (this.wasPaired || mapped === "desktop-disconnected") {
      this.scheduleReconnect();
      return;
    }
    this.setState("error");
    this.options.onFailure?.({
      reason: mapped ?? "relay-unavailable",
      message: reason || `connection closed (${code})`,
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state_ !== "paired" && this.state_ !== "waiting") return;
      if (Date.now() - this.lastPairStatusAckAt > HEARTBEAT_ACK_TIMEOUT_MS) {
        void this.reconnect();
        return;
      }
      this.sendFrame({ type: "pair_status_query", device_sid: this.params.deviceSid });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private startWaitingTimer(): void {
    this.clearWaitingTimers();
    this.waitingTimer = setTimeout(() => {
      if (this.state_ === "waiting" && !this.wasPaired) {
        this.setState("error");
        this.options.onFailure?.({
          reason: "invalid-mobile-connection",
          message: "Desktop did not match this terminal connection before the waiting timeout.",
        });
      }
    }, WAITING_TIMEOUT_MS);
  }

  private clearWaitingTimers(): void {
    if (this.waitingTimer) {
      clearTimeout(this.waitingTimer);
      this.waitingTimer = undefined;
    }
    if (this.rewaitTimer) {
      clearTimeout(this.rewaitTimer);
      this.rewaitTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.intentionallyClosed) return;
    this.setState("reconnecting");
    const delayMs = Math.min(1000 * (1 << Math.min(this.reconnectAttempt, 4)), 15000);
    this.reconnectAttempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.disposed) this.connectSocket();
    }, delayMs);
  }

  private async reconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // 经过 reconnecting 状态，让上层（bridge 恢复）感知连接已断开。
    this.setState("reconnecting");
    this.connectSocket();
  }

  dispose(): void {
    this.disposed = true;
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setState("closed");
  }
}

function detectPlatform(): string {
  const platform = globalThis.navigator?.platform?.toLowerCase() ?? "";
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  if (platform.includes("linux")) return "linux";
  return "web";
}
