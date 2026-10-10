// RelayBridge：一条工作区桥。transport 可在恢复时被替换，protocol 引用保持稳定。
import { Emitter, VSBuffer, type IMessagePassingProtocol } from "@zcode/rpc";
import type { RpcFrameTransport } from "./rpcFrameTransport.js";

export class RelayBridge {
  private transport: RpcFrameTransport;
  private readonly messageEmitter = new Emitter<VSBuffer>();
  private readonly recoveredEmitter = new Emitter<void>();
  private readonly degradedEmitter = new Emitter<string>();
  private disposed_ = false;

  readonly protocol: IMessagePassingProtocol;

  constructor(
    public info: Record<string, unknown>,
    transport: RpcFrameTransport,
  ) {
    this.transport = transport;
    this.attachTransport();
    this.protocol = {
      send: (buffer: VSBuffer) => {
        if (!this.disposed_) this.transport.sendMessage(buffer.buffer);
      },
      onMessage: this.messageEmitter.event,
    };
  }

  private attachTransport(): void {
    this.transport.onMessage = (message) => this.messageEmitter.fire(VSBuffer.wrap(message));
  }

  get workspaceKey(): string | null {
    return typeof this.info["workspaceKey"] === "string"
      ? (this.info["workspaceKey"] as string)
      : null;
  }

  get initialTaskId(): string | null {
    return typeof this.info["initialTaskId"] === "string"
      ? (this.info["initialTaskId"] as string)
      : null;
  }

  /** bridge 降级原因（null = 健康）。 */
  get degradedReason(): string | null {
    return this.degradedReason_;
  }
  private degradedReason_: string | null = null;

  readonly onRecovered = this.recoveredEmitter.event;
  readonly onDegraded = this.degradedEmitter.event;

  /** 由 RemoteClient 在 bridge-degraded / relay 重连时调用。 */
  markDegraded(reason: string): void {
    if (this.disposed_) return;
    this.degradedReason_ = reason;
    this.degradedEmitter.fire(reason);
  }

  /** 恢复：换入新的 rpc-frame transport（同一代桥对象，保持 protocol 引用）。 */
  swapTransport(info: Record<string, unknown>, transport: RpcFrameTransport): void {
    if (this.disposed_) return;
    this.transport.dispose();
    this.info = info;
    this.transport = transport;
    this.attachTransport();
    this.degradedReason_ = null;
    this.recoveredEmitter.fire();
  }

  clearDegraded(): void {
    if (this.disposed_) return;
    this.degradedReason_ = null;
    this.recoveredEmitter.fire();
  }

  get disposed(): boolean {
    return this.disposed_;
  }

  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    this.transport.dispose();
    this.messageEmitter.dispose();
    this.recoveredEmitter.dispose();
    this.degradedEmitter.dispose();
  }
}
