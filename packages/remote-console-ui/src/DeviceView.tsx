import { useEffect, useMemo, useState } from "react";
import type {
  RelayBootstrapResult,
  RelayState,
  RelayTaskSummary,
  RelayWorkspaceSummary,
} from "@zcode/relay-client";
import { Button } from "@zcode/ui/replay";
import { getOrCreateRelayDevice } from "./deviceCache.js";
import type { StoredDevice } from "./deviceStore.js";
import type { ConversationTarget } from "./types.js";

const STATE_LABEL: Record<RelayState, string> = {
  idle: "未连接",
  connecting: "连接中",
  authenticating: "鉴权中",
  waiting: "等待设备上线",
  paired: "已配对",
  reconnecting: "重连中",
  error: "连接错误",
  kicked: "被其他终端踢下线",
  closed: "已断开",
};

interface DeviceViewProps {
  device: StoredDevice;
  onOpenConversation: (target: ConversationTarget) => void;
  onBack: () => void;
}

function taskTitle(task: RelayTaskSummary): string {
  return task.title?.trim() || task.taskId;
}

/** 工作区 key 规则与仓库约定一致：workspaceIdentity?.trim() || workspacePath。 */
function workspaceKeyOf(workspace: RelayWorkspaceSummary): string | null {
  const identity = workspace.workspaceIdentity?.trim();
  if (identity) return identity;
  const path = workspace.workspacePath?.trim();
  return path || null;
}

interface WorkspaceGroup {
  key: string;
  label: string;
  workspacePath: string;
  tasks: RelayTaskSummary[];
}

export function DeviceView({ device, onOpenConversation, onBack }: DeviceViewProps) {
  const relayDevice = useMemo(() => getOrCreateRelayDevice(device), [device]);
  const [relayState, setRelayState] = useState<RelayState>(relayDevice.state);
  const [bootstrap, setBootstrap] = useState<RelayBootstrapResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    relayDevice.onStateChanged(setRelayState);
    relayDevice.connect();
    let cancelled = false;
    relayDevice
      .waitPaired()
      .then(() => relayDevice.bootstrap())
      .then((result) => {
        if (!cancelled) setBootstrap(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [relayDevice]);

  const groups = useMemo<WorkspaceGroup[]>(() => {
    if (!bootstrap) return [];
    const tasks = [...(bootstrap.tasks ?? [])].sort(
      (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
    const tasksByWorkspace = new Map<string, RelayTaskSummary[]>();
    for (const task of tasks) {
      const key = task.workspacePath ?? "（未知工作区）";
      const list = tasksByWorkspace.get(key) ?? [];
      list.push(task);
      tasksByWorkspace.set(key, list);
    }

    const groupsByKey = new Map<string, WorkspaceGroup>();
    // bootstrap.workspaces 是全量工作区（含没有任务的），新建任务入口挂在工作区上。
    for (const workspace of bootstrap.workspaces ?? []) {
      const key = workspaceKeyOf(workspace);
      const path = workspace.workspacePath ?? key;
      if (!key || !path) continue;
      groupsByKey.set(key, {
        key,
        label: workspace.workspaceLabel?.trim() || path,
        workspacePath: path,
        tasks: [],
      });
    }
    for (const [workspacePath, workspaceTasks] of tasksByWorkspace) {
      const existing =
        groupsByKey.get(workspacePath) ??
        [...groupsByKey.values()].find((group) => group.workspacePath === workspacePath);
      if (existing) {
        existing.tasks = workspaceTasks;
      } else {
        groupsByKey.set(workspacePath, {
          key: workspacePath,
          label: workspacePath,
          workspacePath,
          tasks: workspaceTasks,
        });
      }
    }
    return [...groupsByKey.values()];
  }, [bootstrap]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-5 bg-background px-6 py-8 text-foreground">
      <header className="flex items-center gap-3">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← 设备列表
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold">{device.name}</div>
          {bootstrap?.desktopAppVersion ? (
            <div className="text-xs text-muted-foreground">
              桌面端 v{bootstrap.desktopAppVersion}
            </div>
          ) : null}
        </div>
        <span
          className={
            relayState === "paired"
              ? "rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs text-green-400"
              : relayState === "kicked" || relayState === "error"
                ? "rounded-full bg-red-500/10 px-2.5 py-1 text-xs text-red-400"
                : "rounded-full bg-amber-500/15 px-2.5 py-1 text-xs text-amber-400"
          }
        >
          {STATE_LABEL[relayState]}
        </span>
      </header>

      {relayState === "kicked" ? (
        <p className="rounded-md border border-destructive/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          另一台终端接管了这台设备（远程链接同一时间只允许一个控制端）。刷新或重新进入可重连。
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md border border-destructive/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {groups.length === 0 && relayState === "paired" && bootstrap ? (
        <p className="text-sm text-muted-foreground">桌面端当前没有打开的工作区。</p>
      ) : null}

      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
              {group.label}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onOpenConversation({ workspacePath: group.workspacePath, taskId: null })
              }
            >
              ＋ 新建任务
            </Button>
          </div>
          {group.tasks.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">这个工作区还没有任务。</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {group.tasks.map((task) => (
                <li key={task.taskId}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left hover:border-primary"
                    onClick={() =>
                      onOpenConversation({
                        workspacePath: task.workspacePath ?? group.workspacePath,
                        taskId: task.taskId,
                        ...(task.title ? { title: task.title } : {}),
                      })
                    }
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{taskTitle(task)}</span>
                    {task.displayStatus ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {task.displayStatus}
                      </span>
                    ) : null}
                    {task.updatedAt ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(task.updatedAt).toLocaleString()}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
