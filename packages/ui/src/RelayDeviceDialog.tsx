/* eslint-disable max-lines -- 设备管理与「打开其他目录」流程同属一个入口弹窗，先保持同文件收口。 */
// relay 远程控制的设备/工作区入口弹窗：粘贴被控端（未修改的官方 ZCode 桌面）
// 生成的远程链接添加设备，选中设备后列出其打开的工作区，打开即把桥接服务注册进
// 本窗口的 remoteWorkspaceSessionStore，并以远程 tab 形式出现在侧栏。
// 能力探测：平台（web/stub）未实现 addRelayRemoteDevice 时整个入口不渲染。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { RelayRemoteDeviceSummary, RelayRemoteWorkspaceSummary } from "@zcode/shared";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";

interface RelayDeviceDialogProps {
  trigger?: ReactNode;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerClassName?: string;
}

export function RelayDeviceDialog({
  trigger,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
}: RelayDeviceDialogProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const addTab = useTabStore((state) => state.addTab);
  const supported =
    typeof platform.addRelayRemoteDevice === "function" &&
    typeof platform.listRelayRemoteDevices === "function" &&
    typeof platform.removeRelayRemoteDevice === "function" &&
    typeof platform.listRelayRemoteWorkspaces === "function" &&
    typeof platform.openRelayRemoteWorkspace === "function";
  // 「打开其他目录」依赖被控端 terminal channel（仅桌面 renderer 实现），可选能力。
  const canOpenByPath = typeof platform.openRelayRemoteWorkspaceByPath === "function";

  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<RelayRemoteDeviceSummary[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<RelayRemoteDeviceSummary | null>(null);
  const [workspaces, setWorkspaces] = useState<RelayRemoteWorkspaceSummary[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [openingWorkspaceKey, setOpeningWorkspaceKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [otherDirectoryOpen, setOtherDirectoryOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [recentProjects, setRecentProjects] = useState<string[] | null>(null);
  const [openingByPath, setOpeningByPath] = useState(false);

  const refreshDevices = useCallback(async () => {
    if (!supported) return;
    setDevices(await platform.listRelayRemoteDevices!());
  }, [platform, supported]);

  useEffect(() => {
    if (open) {
      void refreshDevices();
    }
  }, [open, refreshDevices]);

  const loadWorkspaces = useCallback(
    async (device: RelayRemoteDeviceSummary) => {
      setLoadingWorkspaces(true);
      setError("");
      try {
        const result = await platform.listRelayRemoteWorkspaces!(device.id);
        if (result.error) {
          setError(result.error);
          setWorkspaces([]);
          return;
        }
        setWorkspaces(result.workspaces ?? []);
      } finally {
        setLoadingWorkspaces(false);
      }
    },
    [platform],
  );

  const resetAndClose = useCallback(() => {
    setOpen(false);
    setSelectedDevice(null);
    setWorkspaces([]);
    setError("");
    setOpeningWorkspaceKey(null);
    setOtherDirectoryOpen(false);
    setPathInput("");
    setRecentProjects(null);
    setOpeningByPath(false);
  }, []);

  if (!supported) {
    return null;
  }

  const handleAddDevice = async () => {
    const rawUrl = urlInput.trim();
    if (!rawUrl || adding) return;
    setAdding(true);
    setError("");
    try {
      const result = await platform.addRelayRemoteDevice!(rawUrl);
      if (result.error) {
        setError(result.error);
        return;
      }
      setUrlInput("");
      await refreshDevices();
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveDevice = async (device: RelayRemoteDeviceSummary) => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "relayRemote.removeConfirmTitle" }),
      description: intl.formatMessage({ id: "relayRemote.removeConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "relayRemote.removeConfirmAction" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
    if (!confirmed) return;
    await platform.removeRelayRemoteDevice!(device.id);
    if (selectedDevice?.id === device.id) {
      setSelectedDevice(null);
      setWorkspaces([]);
    }
    await refreshDevices();
  };

  const handleSelectDevice = (device: RelayRemoteDeviceSummary) => {
    setSelectedDevice(device);
    setWorkspaces([]);
    void loadWorkspaces(device);
  };

  const handleOpenWorkspace = async (workspace: RelayRemoteWorkspaceSummary) => {
    if (!selectedDevice || openingWorkspaceKey) return;
    setOpeningWorkspaceKey(workspace.workspaceKey);
    setError("");
    try {
      const result = await platform.openRelayRemoteWorkspace!({
        deviceId: selectedDevice.id,
        workspaceKey: workspace.workspaceKey,
      });
      if (result.error || !result.sessionId || !result.workspacePath) {
        setError(result.error ?? intl.formatMessage({ id: "relayRemote.openFailed" }));
        return;
      }
      addTab(result.workspacePath, { remoteSessionId: result.sessionId });
      resetAndClose();
    } finally {
      setOpeningWorkspaceKey(null);
    }
  };

  const handleToggleOtherDirectory = async () => {
    const next = !otherDirectoryOpen;
    setOtherDirectoryOpen(next);
    setError("");
    // 首次展开时拉取被控端最近项目作为路径候选；失败不阻塞手动输入。
    if (next && recentProjects === null && selectedDevice) {
      if (typeof platform.listRelayRemoteRecentProjects !== "function") {
        setRecentProjects([]);
        return;
      }
      const result = await platform.listRelayRemoteRecentProjects(selectedDevice.id);
      setRecentProjects(result.projects ?? []);
    }
  };

  const handleOpenByPath = async (rawPath: string) => {
    const workspacePath = rawPath.trim();
    if (!selectedDevice || !workspacePath || openingByPath || !canOpenByPath) return;
    setOpeningByPath(true);
    setError("");
    try {
      const result = await platform.openRelayRemoteWorkspaceByPath!({
        deviceId: selectedDevice.id,
        workspacePath,
      });
      if (result.error || !result.sessionId || !result.workspacePath) {
        setError(result.error ?? intl.formatMessage({ id: "relayRemote.openFailed" }));
        return;
      }
      addTab(result.workspacePath, { remoteSessionId: result.sessionId });
      resetAndClose();
    } finally {
      setOpeningByPath(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        size={triggerSize}
        data-icon="inline-start"
        data-testid="relay-remote-trigger"
        className={triggerClassName}
        onClick={() => setOpen(true)}
      >
        {trigger ?? intl.formatMessage({ id: "relayRemote.trigger" })}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setOpen(true);
          } else {
            resetAndClose();
          }
        }}
      >
        <DialogContent className="max-w-lg" data-testid="relay-remote-dialog">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: "relayRemote.title" })}</DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "relayRemote.description" })}
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div
              data-testid="relay-remote-error"
              className="rounded-xl bg-destructive px-4 py-3 text-ui-base text-destructive-foreground"
            >
              {error}
            </div>
          ) : null}

          {!selectedDevice ? (
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  placeholder={intl.formatMessage({ id: "relayRemote.addPlaceholder" })}
                  data-testid="relay-remote-url-input"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleAddDevice();
                    }
                  }}
                />
                <Button
                  type="button"
                  onClick={() => void handleAddDevice()}
                  disabled={!urlInput.trim() || adding}
                  data-testid="relay-remote-add-device"
                >
                  {adding ? <Loader2 className="size-4 animate-spin" /> : null}
                  {intl.formatMessage({ id: "relayRemote.addDevice" })}
                </Button>
              </div>

              {devices.length === 0 ? (
                <p className="py-6 text-center text-ui-sm text-muted-foreground">
                  {intl.formatMessage({ id: "relayRemote.emptyDevices" })}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {devices.map((device) => (
                    <li key={device.id} className="group flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        data-icon="inline-start"
                        className="min-w-0 flex-1 justify-start gap-2"
                        onClick={() => handleSelectDevice(device)}
                        data-testid={`relay-remote-device-${device.id}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-left">{device.name}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={intl.formatMessage({ id: "relayRemote.removeDevice" })}
                        title={intl.formatMessage({ id: "relayRemote.removeDevice" })}
                        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                        onClick={() => void handleRemoveDevice(device)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={intl.formatMessage({ id: "common.back" })}
                  onClick={() => {
                    setSelectedDevice(null);
                    setWorkspaces([]);
                    setError("");
                  }}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <span className="min-w-0 flex-1 truncate font-medium">{selectedDevice.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={intl.formatMessage({ id: "common.refresh" })}
                  title={intl.formatMessage({ id: "common.refresh" })}
                  disabled={loadingWorkspaces}
                  onClick={() => void loadWorkspaces(selectedDevice)}
                >
                  <RefreshCw className={loadingWorkspaces ? "size-4 animate-spin" : "size-4"} />
                </Button>
              </div>

              {loadingWorkspaces ? (
                <p className="flex items-center justify-center gap-2 py-6 text-ui-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {intl.formatMessage({ id: "relayRemote.loadingWorkspaces" })}
                </p>
              ) : workspaces.length === 0 ? (
                <p className="py-6 text-center text-ui-sm text-muted-foreground">
                  {intl.formatMessage({ id: "relayRemote.emptyWorkspaces" })}
                </p>
              ) : (
                <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                  {workspaces.map((workspace) => (
                    <li key={workspace.workspaceKey}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        data-icon="inline-start"
                        className="w-full justify-start gap-2"
                        disabled={openingWorkspaceKey !== null || openingByPath}
                        onClick={() => void handleOpenWorkspace(workspace)}
                        data-testid="relay-remote-workspace-open"
                      >
                        {openingWorkspaceKey === workspace.workspaceKey ? (
                          <Loader2 className="size-4 shrink-0 animate-spin" />
                        ) : (
                          <FolderGit2 className="size-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-left">
                          {workspace.workspaceLabel ?? workspace.workspacePath}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {canOpenByPath ? (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    data-icon="inline-start"
                    className="w-full justify-start gap-2 text-muted-foreground"
                    onClick={() => void handleToggleOtherDirectory()}
                    data-testid="relay-remote-other-directory-toggle"
                  >
                    {otherDirectoryOpen ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                    {intl.formatMessage({ id: "relayRemote.otherDirectory" })}
                  </Button>

                  {otherDirectoryOpen ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-ui-xs text-muted-foreground">
                        {intl.formatMessage({ id: "relayRemote.otherDirectoryHint" })}
                      </p>
                      {openingByPath ? (
                        <p className="flex items-center gap-2 text-ui-sm text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" />
                          {intl.formatMessage({ id: "relayRemote.openingByPath" })}
                        </p>
                      ) : null}
                      <div className="flex gap-2">
                        <Input
                          value={pathInput}
                          onChange={(event) => setPathInput(event.target.value)}
                          placeholder={intl.formatMessage({
                            id: "relayRemote.pathPlaceholder",
                          })}
                          disabled={openingByPath}
                          data-testid="relay-remote-path-input"
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void handleOpenByPath(pathInput);
                            }
                          }}
                        />
                        <Button
                          type="button"
                          onClick={() => void handleOpenByPath(pathInput)}
                          disabled={!pathInput.trim() || openingByPath}
                          data-testid="relay-remote-open-by-path"
                        >
                          {intl.formatMessage({ id: "relayRemote.openAndAttach" })}
                        </Button>
                      </div>
                      {recentProjects && recentProjects.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          <p className="text-ui-xs text-muted-foreground">
                            {intl.formatMessage({ id: "relayRemote.recentProjects" })}
                          </p>
                          <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto">
                            {recentProjects.map((project) => (
                              <li key={project}>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-auto w-full justify-start py-1 text-muted-foreground"
                                  disabled={openingByPath}
                                  onClick={() => setPathInput(project)}
                                  data-testid="relay-remote-recent-project"
                                >
                                  <span className="min-w-0 flex-1 truncate text-left">
                                    {project}
                                  </span>
                                </Button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
