// 浏览器/辅助窗口宿主的 IPlatformService 空实现：远程控制端没有桌面宿主能力，
// 所有平台操作保持 no-op / unsupported，参照 packages/web/src/main.tsx 的 createWebPlatform。
import type { IPlatformService } from "@zcode/shared";

export function createConsolePlatform(): IPlatformService {
  return {
    canSelectFilePath: false,
    selectDirectory: () => Promise.resolve(null),
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: () =>
      Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    connectRemote: (options) =>
      Promise.resolve({
        success: false,
        error: `Remote connect is handled by the relay bridge, not the platform: ${options.kind}`,
      }),
    cancelPendingRemoteConnection: () => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({ success: false, error: "Not supported in remote console" }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({ servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: () => Promise.resolve(),
    openCommunity: () => Promise.resolve(),
    canOpenCommunity: () => Promise.resolve(false),
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in remote console" }),
    openExternalFile: () =>
      Promise.resolve({ success: false, error: "Not supported in remote console" }),
    registerOAuthState: () => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    showTaskNotification: (payload) => {
      if (document.hasFocus()) return;
      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }
      try {
        new window.Notification(payload.title, { body: payload.body, silent: true });
      } catch {
        // 浏览器通知不可用时静默忽略
      }
    },
    reportTelemetryEvent: () => Promise.resolve(),
    reportArmsCustomEvent: () => Promise.resolve(),
    syncWindowTabs: () => {},
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in remote console" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: () =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in remote console" }),
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () =>
      Promise.resolve({ success: false, error: "Not supported in remote console" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: () => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const parts = [
        nav?.platform ?? "",
        String(globalThis.screen?.width ?? ""),
        String(globalThis.screen?.height ?? ""),
        String(globalThis.screen?.colorDepth ?? ""),
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}
