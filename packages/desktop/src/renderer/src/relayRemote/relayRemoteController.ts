/* eslint-disable max-lines -- relay 连接管理、桥接注册与「打开其他目录」的 terminal 借道逻辑是同一生命周期域，拆分会割裂状态所有权。 */
// relay 远程控制（被控端 = 未修改的官方 ZCode 桌面）的窗口内连接管理。
// 与 SSH/WSL/Docker 远程工作区不同：bridge 的 RPC 面来自 relay 对端桌面自己的
// Host attachment，不经本机 main/host，因此不创建 RemoteTarget / logical session，
// 而是参照手机 web relay 的做法，直接在 renderer 把服务注册进
// remoteWorkspaceSessionStore（store 的 session.target 本就可选）。
// 注册后主界面的任务分片订阅与 V4ConversationProvider 走标准远程解析链，
// 远程工作区成为侧栏一等公民。
import { connectViaProtocol } from "@zcode/client";
import {
  connectRelayDevice,
  crc32Hex,
  parseRemoteConnectionUrl,
  type RelayDevice,
  type RelayWorkspaceSummary,
} from "@zcode/relay-client";
import type { RelayRemoteDeviceSummary, RelayRemoteWorkspaceSummary } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  bindRemoteWorkspacePath,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@zcode/ui";
import { buildRemoteWorkspaceSessionServices } from "../remoteWorkspaceSessionServices.js";

const DEVICES_STORAGE_KEY = "zcode-relay-remote-devices";
const WORKSPACES_STORAGE_KEY = "zcode-relay-remote-workspaces";

interface PersistedRelayWorkspace {
  deviceId: string;
  workspaceKey: string;
  workspacePath: string;
  sessionId: string;
}

interface OpenWorkspaceRecord {
  deviceId: string;
  workspaceKey: string;
  workspacePath: string;
  disposeBridge: () => void;
}

let baseServices: IServiceAccessor | null = null;
const deviceConnections = new Map<string, RelayDevice>();
const openWorkspaces = new Map<string, OpenWorkspaceRecord>();
const pendingOpenWorkspaces = new Map<string, Promise<void>>();

function loadDevices(): RelayRemoteDeviceSummary[] {
  try {
    const raw = localStorage.getItem(DEVICES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RelayRemoteDeviceSummary =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as RelayRemoteDeviceSummary).id === "string" &&
        typeof (item as RelayRemoteDeviceSummary).url === "string",
    );
  } catch {
    return [];
  }
}

function saveDevices(devices: RelayRemoteDeviceSummary[]): void {
  localStorage.setItem(DEVICES_STORAGE_KEY, JSON.stringify(devices));
}

function loadPersistedWorkspaces(): PersistedRelayWorkspace[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PersistedRelayWorkspace =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PersistedRelayWorkspace).deviceId === "string" &&
        typeof (item as PersistedRelayWorkspace).workspaceKey === "string" &&
        typeof (item as PersistedRelayWorkspace).sessionId === "string",
    );
  } catch {
    return [];
  }
}

function savePersistedWorkspaces(workspaces: PersistedRelayWorkspace[]): void {
  localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces));
}

function relaySessionId(deviceId: string, workspaceKey: string): string {
  return `relay-${deviceId}-${crc32Hex(new TextEncoder().encode(workspaceKey))}`;
}

function findStoredDevice(deviceId: string): RelayRemoteDeviceSummary | null {
  return loadDevices().find((device) => device.id === deviceId) ?? null;
}

async function ensureDevicePaired(deviceId: string): Promise<RelayDevice> {
  const stored = findStoredDevice(deviceId);
  if (!stored) {
    throw new Error("设备不存在或已被移除");
  }
  let device = deviceConnections.get(deviceId);
  if (!device) {
    device = connectRelayDevice(stored.url, { clientName: "zcode-desktop" });
    deviceConnections.set(deviceId, device);
  }
  device.connect();
  await device.waitPaired();
  return device;
}

export function initializeRelayRemoteController(services: IServiceAccessor): void {
  baseServices = services;
  // 启动恢复：窗口 tab 是按 remoteSessionId 持久化恢复的，sessionId 由
  // deviceId+workspaceKey 派生、跨重启稳定；这里为已持久化的工作区重建桥接并
  // 重新注册，否则恢复的 tab 会因 store 里查不到 session 永远 remote-waiting。
  // 设备离线/被抢占时跳过：用户重新打开对话框时会按同一路径重试。
  for (const workspace of loadPersistedWorkspaces()) {
    void openRelayRemoteWorkspace({
      deviceId: workspace.deviceId,
      workspaceKey: workspace.workspaceKey,
    }).catch((error: unknown) => {
      console.warn("[relay-remote] 启动恢复工作区桥接失败:", {
        deviceId: workspace.deviceId,
        workspacePath: workspace.workspacePath,
        error,
      });
    });
  }
}

export function listRelayRemoteDevices(): RelayRemoteDeviceSummary[] {
  return loadDevices();
}

export function addRelayRemoteDevice(rawUrl: string): {
  device?: RelayRemoteDeviceSummary;
  error?: string;
} {
  const params = parseRemoteConnectionUrl(rawUrl.trim());
  if (!params) {
    return { error: "无法识别的远程链接：需要 https://…/remote/v4?sid=…&hash=…&t=… 形式" };
  }
  const devices = loadDevices();
  const device: RelayRemoteDeviceSummary = {
    id: params.deviceSid,
    name: params.deviceName ?? params.deviceSid,
    url: params.sourceUrl,
    addedAt: Date.now(),
  };
  const index = devices.findIndex((item) => item.id === device.id);
  // 同设备重复添加视为凭据轮换，覆盖链接；已建立的连接沿用旧凭据，下次连接时重建。
  if (index >= 0) {
    devices[index] = device;
  } else {
    devices.push(device);
  }
  saveDevices(devices);
  return { device };
}

export async function removeRelayRemoteDevice(deviceId: string): Promise<void> {
  saveDevices(loadDevices().filter((device) => device.id !== deviceId));
  savePersistedWorkspaces(
    loadPersistedWorkspaces().filter((workspace) => workspace.deviceId !== deviceId),
  );
  for (const [sessionId, record] of openWorkspaces) {
    if (record.deviceId !== deviceId) continue;
    openWorkspaces.delete(sessionId);
    record.disposeBridge();
    unregisterRemoteWorkspaceSession(sessionId);
  }
  const device = deviceConnections.get(deviceId);
  if (device) {
    deviceConnections.delete(deviceId);
    device.dispose();
  }
}

export async function listRelayRemoteWorkspaces(deviceId: string): Promise<{
  workspaces?: RelayRemoteWorkspaceSummary[];
  error?: string;
}> {
  try {
    const device = await ensureDevicePaired(deviceId);
    const bootstrap = await device.bootstrap();
    const workspaces: RelayRemoteWorkspaceSummary[] = [];
    for (const workspace of bootstrap.workspaces ?? []) {
      const summary = toWorkspaceSummary(workspace);
      if (summary) workspaces.push(summary);
    }
    return { workspaces };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function toWorkspaceSummary(workspace: RelayWorkspaceSummary): RelayRemoteWorkspaceSummary | null {
  const identity = workspace.workspaceIdentity?.trim();
  const path = workspace.workspacePath?.trim() ?? "";
  const workspaceKey = identity || path;
  if (!workspaceKey || !path) return null;
  const label = workspace.workspaceLabel?.trim();
  return {
    workspaceKey,
    workspacePath: path,
    ...(label ? { workspaceLabel: label } : {}),
  };
}

export async function openRelayRemoteWorkspace(options: {
  deviceId: string;
  workspaceKey: string;
}): Promise<{ sessionId?: string; workspacePath?: string; error?: string }> {
  if (!baseServices) {
    return { error: "窗口服务尚未就绪，请稍后重试" };
  }
  const sessionId = relaySessionId(options.deviceId, options.workspaceKey);
  const established = openWorkspaces.get(sessionId);
  if (established) {
    return { sessionId, workspacePath: established.workspacePath };
  }
  const pending = pendingOpenWorkspaces.get(sessionId);
  if (pending) {
    await pending.catch(() => {});
    const settled = openWorkspaces.get(sessionId);
    return settled
      ? { sessionId, workspacePath: settled.workspacePath }
      : { error: "工作区桥接建立失败，请重试" };
  }

  const openPromise = (async (): Promise<void> => {
    const device = await ensureDevicePaired(options.deviceId);
    const bridge = await device.openBridge({ workspaceKey: options.workspaceKey });
    const remoteServices = connectViaProtocol(bridge.protocol);
    const services = buildRemoteWorkspaceSessionServices(baseServices!, remoteServices);
    const workspacePath =
      typeof bridge.info["workspacePath"] === "string"
        ? (bridge.info["workspacePath"] as string)
        : options.workspaceKey;
    registerRemoteWorkspaceSession({
      sessionId,
      services,
      dispose: () => bridge.dispose(),
    });
    bindRemoteWorkspacePath(workspacePath, sessionId);
    openWorkspaces.set(sessionId, {
      deviceId: options.deviceId,
      workspaceKey: options.workspaceKey,
      workspacePath,
      disposeBridge: () => bridge.dispose(),
    });
    const persisted = loadPersistedWorkspaces().filter(
      (workspace) => workspace.sessionId !== sessionId,
    );
    persisted.push({
      deviceId: options.deviceId,
      workspaceKey: options.workspaceKey,
      workspacePath,
      sessionId,
    });
    savePersistedWorkspaces(persisted);
  })();

  pendingOpenWorkspaces.set(sessionId, openPromise);
  try {
    await openPromise;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    pendingOpenWorkspaces.delete(sessionId);
  }
  const record = openWorkspaces.get(sessionId);
  return record
    ? { sessionId, workspacePath: record.workspacePath }
    : { error: "工作区桥接建立失败，请重试" };
}

// ——「打开其他目录」支持：官方被控端拒绝为未打开的工作区开桥（PoC 实证返回
// “目标工作区不在当前桌面窗口中”），但任一已打开工作区的桥接上 terminal channel
// 可用（与被控端任务内终端同一能力面）。借它执行
// `ZCode.exe --open-workspace <path>`（second-instance 通道，无确认弹窗），
// 让被控端桌面自己打开目录，随后按普通流程开桥接入。

const ZCODE_EXE_QUERY_COMMAND =
  "(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -match 'ZCode\\.exe$' } | Select-Object -First 1 -ExpandProperty Path)";
const CONTROLLED_OPEN_TIMEOUT_MS = 45_000;
const zcodeExePathByDevice = new Map<string, string>();

function normalizeRelayPathForCompare(path: string): string {
  const unified = path.trim().replace(/\//g, "\\");
  // 只去掉非根路径末尾的分隔符（保留 C:\ 这样的根目录）。
  const trimmed = unified.length > 3 ? unified.replace(/\\+$/, "") : unified;
  return trimmed.toLowerCase();
}

function findOpenWorkspaceEntry(
  workspaces: readonly RelayWorkspaceSummary[] | undefined,
  workspacePath: string,
): RelayWorkspaceSummary | undefined {
  const wantedKey = normalizeRelayPathForCompare(workspacePath);
  return (workspaces ?? []).find((workspace) => {
    const path = workspace.workspacePath?.trim();
    return path ? normalizeRelayPathForCompare(path) === wantedKey : false;
  });
}

function workspaceEntryKey(workspace: RelayWorkspaceSummary): string {
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath!.trim();
}

async function withAnchorBridgeServices<T>(
  device: RelayDevice,
  fn: (services: IServiceAccessor) => Promise<T>,
): Promise<T> {
  const bootstrap = await device.bootstrap();
  const anchor = (bootstrap.workspaces ?? []).find((workspace) => workspace.workspacePath?.trim());
  if (!anchor?.workspacePath) {
    throw new Error("被控端当前没有打开任何工作区，无法执行该操作");
  }
  const bridge = await device.openBridge({ workspaceKey: workspaceEntryKey(anchor) });
  try {
    return await fn(connectViaProtocol(bridge.protocol));
  } finally {
    bridge.dispose();
  }
}

interface AnchorTerminalSession {
  shell: string;
  write: (data: string) => Promise<void>;
  readOutput: () => string;
}

async function withAnchorTerminal<T>(
  device: RelayDevice,
  fn: (terminal: AnchorTerminalSession) => Promise<T>,
): Promise<T> {
  return withAnchorBridgeServices(device, async (services) => {
    const bootstrap = await device.bootstrap();
    const anchor = (bootstrap.workspaces ?? []).find((workspace) =>
      workspace.workspacePath?.trim(),
    );
    const terminal = await services.terminalService.create({
      cols: 200,
      rows: 30,
      cwd: anchor?.workspacePath?.trim(),
    });
    let output = "";
    const subscription = services.terminalService.onDynamicData(terminal.id)((data) => {
      output += data;
    });
    try {
      return await fn({
        shell: terminal.shell,
        write: (data) => services.terminalService.write({ id: terminal.id, data }),
        readOutput: () => output,
      });
    } finally {
      subscription.dispose();
      await services.terminalService.dispose({ id: terminal.id }).catch(() => {});
    }
  });
}

async function queryControlledZCodeExePath(
  terminal: AnchorTerminalSession,
): Promise<string | null> {
  const isCmd = /cmd\.exe/i.test(terminal.shell);
  const command = isCmd
    ? `powershell -NoProfile -Command "${ZCODE_EXE_QUERY_COMMAND}"`
    : ZCODE_EXE_QUERY_COMMAND;
  await terminal.write(`${command}\r`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // 终端回显里只有查询 pattern（无盘符前缀），不会误匹配到输入回显。
    const match = terminal.readOutput().match(/[A-Za-z]:\\[^\r\n"]*?ZCode\.exe/i);
    if (match) {
      return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

async function launchControlledWorkspaceOpen(
  terminal: AnchorTerminalSession,
  exePath: string,
  workspacePath: string,
): Promise<void> {
  const isCmd = /cmd\.exe/i.test(terminal.shell);
  const command = isCmd
    ? `start "" "${exePath}" --open-workspace "${workspacePath}"`
    : `Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -ArgumentList '--open-workspace','"${workspacePath.replace(/'/g, "''")}"'`;
  await terminal.write(`${command}\r`);
}

export async function listRelayRemoteRecentProjects(deviceId: string): Promise<{
  projects?: string[];
  error?: string;
}> {
  try {
    const device = await ensureDevicePaired(deviceId);
    const projects = await withAnchorBridgeServices(device, async (services) => {
      const settings = await services.settingService.get();
      return (settings.recentProjects ?? []).filter(
        (path): path is string => typeof path === "string" && path.trim().length > 0,
      );
    });
    return { projects };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function openRelayRemoteWorkspaceByPath(options: {
  deviceId: string;
  workspacePath: string;
}): Promise<{ sessionId?: string; workspacePath?: string; error?: string }> {
  const workspacePath = options.workspacePath.trim();
  if (!workspacePath) {
    return { error: "目录路径不能为空" };
  }
  try {
    const device = await ensureDevicePaired(options.deviceId);

    // 路径可能已在被控端打开（用户手输的路径与列表项存在大小写/分隔符变体）。
    const bootstrap = await device.bootstrap();
    const alreadyOpen = findOpenWorkspaceEntry(bootstrap.workspaces, workspacePath);
    if (alreadyOpen) {
      return openRelayRemoteWorkspace({
        deviceId: options.deviceId,
        workspaceKey: workspaceEntryKey(alreadyOpen),
      });
    }

    await withAnchorTerminal(device, async (terminal) => {
      let exePath = zcodeExePathByDevice.get(options.deviceId) ?? null;
      if (!exePath) {
        exePath = await queryControlledZCodeExePath(terminal);
        if (!exePath) {
          throw new Error("未能在被控端找到运行中的 ZCode 桌面进程");
        }
        zcodeExePathByDevice.set(options.deviceId, exePath);
      }
      await launchControlledWorkspaceOpen(terminal, exePath, workspacePath);
    });

    const deadline = Date.now() + CONTROLLED_OPEN_TIMEOUT_MS;
    let opened: RelayWorkspaceSummary | undefined;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const list = await device.bootstrap();
      opened = findOpenWorkspaceEntry(list.workspaces, workspacePath);
      if (opened) {
        break;
      }
    }
    if (!opened) {
      return {
        error: "已通知被控端打开目录，但 45 秒内未出现该工作区；请在被控电脑上确认后重试",
      };
    }
    return openRelayRemoteWorkspace({
      deviceId: options.deviceId,
      workspaceKey: workspaceEntryKey(opened),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
