// 设备级编排：relay payload 请求/响应、bootstrap、工作区列表、bridge 生命周期。
// 参照 ZLinker lib/protocol/remote_client.dart；上层通过 RelayBridge.protocol
// 拿到 IMessagePassingProtocol，交给 @zcode/client 的 connectViaProtocol 消费。
// 公共契约（RelayDevice/RelayBridge/错误与结果类型）见 contract.ts 与 relayBridge.ts。

import { parseRemoteConnectionUrl, type RemoteConnectionParams } from "./connectionParams.js";
import { RelayClient, type RelayState } from "./relayClient.js";
import { RpcFrameTransport } from "./rpcFrameTransport.js";
import { RelayBridge } from "./relayBridge.js";
import { RelayAppError, type RelayBootstrapResult, type RelayDevice } from "./contract.js";

export interface RelayDeviceOptions {
  clientName?: string;
  platform?: string;
  onLog?: (line: string) => void;
}

interface PendingRequest {
  match: (payload: Record<string, unknown>) => boolean;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RelayDeviceImpl implements RelayDevice {
  private readonly relay: RelayClient;
  private readonly pending = new Map<string, PendingRequest>();
  private reqSeq = 0;
  private bridgeGeneration = 0;
  private readonly bridges = new Set<RelayBridge>();
  private readonly frameRouters = new Map<string, (payload: Record<string, unknown>) => void>();
  private readonly pendingBridgePayloads = new Map<string, Record<string, unknown>[]>();
  private needsBridgeRecovery = false;
  private readonly recovering = new Set<RelayBridge>();
  private readonly stateListeners = new Set<(state: RelayState) => void>();

  constructor(
    readonly params: RemoteConnectionParams,
    private readonly options: RelayDeviceOptions,
  ) {
    this.relay = new RelayClient(params, {
      ...(options.clientName ? { clientName: options.clientName } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      onStateChanged: (state) => this.handleRelayState(state),
      onPayload: (payload) => this.dispatchPayload(payload),
      ...(options.onLog ? { onLog: options.onLog } : {}),
    });
  }

  get state(): RelayState {
    return this.relay.state;
  }

  readonly onStateChanged = (listener: (state: RelayState) => void): void => {
    this.stateListeners.add(listener);
  };

  connect(): void {
    this.relay.start();
  }

  waitPaired(timeoutMs = 60_000): Promise<void> {
    if (this.relay.paired) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stateListeners.delete(listener);
        reject(new Error("pairing timeout"));
      }, timeoutMs);
      const listener = (state: RelayState) => {
        if (state === "paired") {
          clearTimeout(timer);
          this.stateListeners.delete(listener);
          resolve();
        }
      };
      this.stateListeners.add(listener);
    });
  }

  private handleRelayState(state: RelayState): void {
    if (state === "reconnecting" || state === "error") {
      if (this.bridges.size > 0) {
        this.needsBridgeRecovery = true;
        for (const bridge of this.bridges) bridge.markDegraded("reconnecting");
      }
    } else if (state === "paired" && this.needsBridgeRecovery) {
      this.needsBridgeRecovery = false;
      void this.recoverBridges();
    }
    for (const listener of this.stateListeners) listener(state);
  }

  private nextRequestId(prefix: string): string {
    return `${prefix}-${++this.reqSeq}-${Date.now().toString(36)}`;
  }

  /** payload 级请求/响应；响应不保证回显 requestId，靠 matcher 判定。 */
  private request(
    payload: Record<string, unknown>,
    match: (payload: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const requestId = this.nextRequestId(String(payload["zcode_type"] ?? "req"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${requestId} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, {
        match,
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      this.relay.sendPayload({ ...payload, requestId });
    });
  }

  private dispatchPayload(payload: Record<string, unknown>): void {
    const type = payload["zcode_type"];
    if (type === "workspace-list-updated" || type === "bridge-degraded") {
      if (type === "bridge-degraded") this.handleBridgeDegraded(payload);
      return;
    }
    if (type === "app-error") {
      this.handleAppError(payload);
      return;
    }
    if (type === "rpc-frame" || type === "rpc-frame-ack") {
      // desktop 可能先于 openBridge 的 await 续体推送帧（Initialize 竞态）：
      // 未知 bridge 的帧先缓冲，注册 router 时回放。
      const id = typeof payload["bridgeSessionId"] === "string" ? payload["bridgeSessionId"] : null;
      const router = id ? this.frameRouters.get(id) : undefined;
      if (router) {
        router(payload);
      } else if (id) {
        const list = this.pendingBridgePayloads.get(id) ?? [];
        list.push(payload);
        this.pendingBridgePayloads.set(id, list);
      }
      return;
    }
    for (const [requestId, entry] of this.pending) {
      if (entry.match(payload)) {
        this.pending.delete(requestId);
        entry.resolve(payload);
        return;
      }
    }
    this.options.onLog?.(
      `[relay-device] unmatched payload: ${JSON.stringify(payload).slice(0, 300)}`,
    );
  }

  private handleAppError(payload: Record<string, unknown>): void {
    const reason = typeof payload["reason"] === "string" ? payload["reason"] : "unexpected-error";
    const message = typeof payload["error"] === "string" ? payload["error"] : undefined;
    const requestId = typeof payload["requestId"] === "string" ? payload["requestId"] : null;
    if (requestId) {
      const entry = this.pending.get(requestId);
      if (entry) {
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(new RelayAppError(reason, message));
      }
    }
  }

  private handleBridgeDegraded(payload: Record<string, unknown>): void {
    const bridgeSessionId =
      typeof payload["bridgeSessionId"] === "string" ? payload["bridgeSessionId"] : null;
    const reason = typeof payload["reason"] === "string" ? payload["reason"] : "unknown";
    for (const bridge of this.bridges) {
      const currentId = (bridge.info["bridgeSessionId"] as string | undefined) ?? null;
      if (currentId === bridgeSessionId) {
        bridge.markDegraded(reason);
      }
    }
    void this.recoverBridges();
  }

  async bootstrap(timeoutMs = 30_000): Promise<RelayBootstrapResult> {
    const res = await this.request(
      { zcode_type: "bootstrap-request" },
      (p) => p["zcode_type"] === "bootstrap-response",
      timeoutMs,
    );
    const result = res["result"];
    return (typeof result === "object" && result !== null ? result : res) as RelayBootstrapResult;
  }

  async listWorkspaces(timeoutMs = 30_000): Promise<unknown> {
    const res = await this.request(
      { zcode_type: "workspace-list-request" },
      (p) => p["zcode_type"] === "workspace-list-response",
      timeoutMs,
    );
    return res["result"];
  }

  async openBridge(options: {
    workspaceKey: string;
    taskId?: string;
    timeoutMs?: number;
  }): Promise<RelayBridge> {
    const bridgeSessionId = this.nextRequestId("bridge");
    const generation = ++this.bridgeGeneration;
    const res = await this.request(
      {
        zcode_type: "workspace-bridge-open",
        bridgeSessionId,
        bridgeGeneration: generation,
        workspaceKey: options.workspaceKey,
        ...(options.taskId ? { taskId: options.taskId } : {}),
      },
      (p) =>
        (p["zcode_type"] === "workspace-bridge-ready" ||
          p["zcode_type"] === "workspace-bridge-error") &&
        p["bridgeSessionId"] === bridgeSessionId,
      options.timeoutMs ?? 60_000,
    );
    if (res["zcode_type"] === "workspace-bridge-error") {
      throw new RelayAppError(
        "workspace-bridge-error",
        typeof res["error"] === "string" ? res["error"] : JSON.stringify(res),
      );
    }
    const info = (
      typeof res["bridge"] === "object" && res["bridge"] !== null ? res["bridge"] : {}
    ) as Record<string, unknown>;
    const transport = this.createTransport(info, bridgeSessionId, generation);
    const bridge = new RelayBridge(info, transport);
    this.registerBridgeRouter(transport);
    this.bridges.add(bridge);
    await this.sendMobileViewState(
      (info["workspaceKey"] as string | undefined) ?? options.workspaceKey,
      (info["initialTaskId"] as string | undefined) ?? options.taskId,
    );
    return bridge;
  }

  private createTransport(
    info: Record<string, unknown>,
    requestedBridgeSessionId: string,
    generation: number,
  ): RpcFrameTransport {
    return new RpcFrameTransport(
      {
        bridgeSessionId:
          (info["bridgeSessionId"] as string | undefined) ?? requestedBridgeSessionId,
        bridgeGeneration: (info["bridgeGeneration"] as number | undefined) ?? generation,
        ...((info["recoveryId"] as string | undefined)
          ? { recoveryId: info["recoveryId"] as string }
          : {}),
      },
      (payload) => this.relay.sendPayload(payload),
      this.options.onLog,
    );
  }

  private registerBridgeRouter(transport: RpcFrameTransport): void {
    const id = transport.bridgeSessionId;
    this.frameRouters.set(id, (payload) => transport.acceptPayload(payload));
    const buffered = this.pendingBridgePayloads.get(id);
    if (buffered) {
      this.pendingBridgePayloads.delete(id);
      for (const payload of buffered) transport.acceptPayload(payload);
    }
  }

  private async recoverBridges(): Promise<void> {
    for (const bridge of this.bridges) {
      if (this.recovering.has(bridge) || bridge.disposed) continue;
      this.recovering.add(bridge);
      void this.recoverBridgeWithRetry(bridge).finally(() => this.recovering.delete(bridge));
    }
  }

  private async recoverBridgeWithRetry(bridge: RelayBridge): Promise<void> {
    for (let attempt = 1; attempt <= 15; attempt++) {
      if (bridge.disposed) return;
      if (await this.recoverBridgeOnce(bridge)) return;
      if (bridge.disposed) return;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  private async recoverBridgeOnce(bridge: RelayBridge): Promise<boolean> {
    const workspaceKey = bridge.workspaceKey;
    if (!workspaceKey) {
      bridge.clearDegraded();
      return true;
    }
    // 1) 便宜路径：workspace-reconnect-request
    try {
      const res = await this.request(
        { zcode_type: "workspace-reconnect-request", workspaceKey },
        (p) =>
          p["zcode_type"] === "workspace-reconnect-response" && p["workspaceKey"] === workspaceKey,
        15_000,
      );
      if (res["success"] === true) {
        bridge.clearDegraded();
        return true;
      }
    } catch {
      // 落入完整重开
    }
    // 2) 完整重开：新 bridgeSessionId、递增 generation、携带 recoveryId
    try {
      const oldInfo = bridge.info;
      const bridgeSessionId = this.nextRequestId("bridge");
      const generation = ++this.bridgeGeneration;
      const res = await this.request(
        {
          zcode_type: "workspace-bridge-open",
          bridgeSessionId,
          bridgeGeneration: generation,
          ...(oldInfo["recoveryId"] ? { recoveryId: oldInfo["recoveryId"] } : {}),
          workspaceKey,
        },
        (p) =>
          (p["zcode_type"] === "workspace-bridge-ready" ||
            p["zcode_type"] === "workspace-bridge-error") &&
          p["bridgeSessionId"] === bridgeSessionId,
        30_000,
      );
      if (res["zcode_type"] === "workspace-bridge-error") {
        throw new RelayAppError("workspace-bridge-error", String(res["error"] ?? ""));
      }
      const info = (
        typeof res["bridge"] === "object" && res["bridge"] !== null ? res["bridge"] : {}
      ) as Record<string, unknown>;
      const oldRouterId = (oldInfo["bridgeSessionId"] as string | undefined) ?? null;
      if (oldRouterId) this.frameRouters.delete(oldRouterId);
      const transport = this.createTransport(info, bridgeSessionId, generation);
      this.registerBridgeRouter(transport);
      bridge.swapTransport(info, transport);
      return true;
    } catch {
      return false;
    }
  }

  private async sendMobileViewState(workspaceKey: string, taskId?: string): Promise<void> {
    this.relay.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
      },
      deviceInfo: {
        platform: this.options.platform ?? "web",
        version: this.params.appVersion ?? "web",
        name: this.options.clientName ?? "zcode-relay-client",
      },
    });
  }

  dispose(): void {
    for (const bridge of this.bridges) bridge.dispose();
    this.bridges.clear();
    this.frameRouters.clear();
    this.pendingBridgePayloads.clear();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("device disposed"));
    }
    this.pending.clear();
    this.relay.dispose();
  }
}

export function connectRelayDevice(
  rawOrParams: string | RemoteConnectionParams,
  options: RelayDeviceOptions = {},
): RelayDevice {
  const params =
    typeof rawOrParams === "string" ? parseRemoteConnectionUrl(rawOrParams) : rawOrParams;
  if (!params) {
    throw new Error("无效的远程链接：缺少 sid/hash/t 参数");
  }
  return new RelayDeviceImpl(params, options);
}
