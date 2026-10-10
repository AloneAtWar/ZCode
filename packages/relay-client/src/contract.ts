// relay-client 公共契约：设备级编排的类型与错误。
// 实现见 remoteClient.ts（RelayDeviceImpl）与 relayBridge.ts（RelayBridge）。
import type { RemoteConnectionParams } from "./connectionParams.js";
import type { RelayState } from "./relayClient.js";
import type { RelayBridge } from "./relayBridge.js";

export interface RelayBootstrapResult {
  readonly desktopAppVersion?: string;
  readonly initialViewState?: {
    readonly activeWorkspaceKey?: string;
    readonly activeTaskId?: string;
    readonly updatedAt?: number;
  };
  readonly workspaces?: readonly RelayWorkspaceSummary[];
  readonly tasks?: readonly RelayTaskSummary[];
  readonly [key: string]: unknown;
}

export interface RelayWorkspaceSummary {
  readonly workspacePath?: string;
  readonly workspaceIdentity?: string;
  readonly workspaceLabel?: string;
  readonly [key: string]: unknown;
}

export interface RelayTaskSummary {
  readonly taskId: string;
  readonly title?: string;
  readonly workspacePath?: string;
  readonly workspaceLabel?: string;
  readonly workspaceKind?: string;
  readonly displayStatus?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly [key: string]: unknown;
}

export class RelayAppError extends Error {
  constructor(
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "RelayAppError";
  }
}

export interface RelayDevice {
  readonly state: RelayState;
  readonly onStateChanged: (listener: (state: RelayState) => void) => void;
  readonly params: RemoteConnectionParams;
  connect(): void;
  waitPaired(timeoutMs?: number): Promise<void>;
  bootstrap(timeoutMs?: number): Promise<RelayBootstrapResult>;
  listWorkspaces(timeoutMs?: number): Promise<unknown>;
  openBridge(options: {
    workspaceKey: string;
    taskId?: string;
    timeoutMs?: number;
  }): Promise<RelayBridge>;
  dispose(): void;
}
