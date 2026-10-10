// 远程控制台共享入口：Provider 栈 + 应用根组件 + 主题引导。
// 同时被 apps/remote-console（浏览器 dev 版）和 packages/desktop 的
// 「远程控制台」辅助窗口复用，两边只差一个 createRoot 调用。
import { StrictMode } from "react";
import {
  DiffsWorkerPoolProvider,
  LucideProvider,
  PlatformProvider,
  StoreProvider,
  TabStoreProvider,
  TooltipProvider,
  ZCodeIntlProvider,
} from "@zcode/ui/replay";
import { App } from "./App.js";
import { createConsolePlatform } from "./platform.js";

// 单窗口应用没有跨窗口广播：本地空实现即可，ZCodeStore 只在本窗口内维护状态。
const broadcastStub = {
  send: () => Promise.resolve(),
  acquireClaim: () => Promise.resolve({ status: "unavailable" as const }),
  commitClaim: () => Promise.resolve(),
  releaseClaim: () => Promise.resolve(),
  tryClaim: () => Promise.resolve(true),
  onMessage: () => ({ dispose: () => {} }),
};

const platform = createConsolePlatform();

// 调试期全局错误兜底：把未捕获异常/拒绝渲染进 DOM，便于无 DevTools 环境排查。
function reportFatal(kind: string, message: string) {
  let box = document.getElementById("fatal-errors");
  if (!box) {
    box = document.createElement("pre");
    box.id = "fatal-errors";
    box.style.cssText =
      "position:fixed;inset:auto 0 0 0;max-height:40%;overflow:auto;z-index:99999;background:#3b0d0d;color:#ffd7d7;font-size:12px;padding:8px;white-space:pre-wrap;margin:0;";
    document.body.append(box);
  }
  box.textContent += `[${kind}] ${message}\n`;
}

let fatalHooksInstalled = false;

function installFatalHooks(): void {
  if (fatalHooksInstalled) return;
  fatalHooksInstalled = true;
  window.addEventListener("error", (event) => {
    reportFatal("error", `${event.message} @ ${event.filename}:${event.lineno}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportFatal(
      "rejection",
      event.reason instanceof Error
        ? (event.reason.stack ?? event.reason.message)
        : String(event.reason),
    );
  });
}

export function RemoteConsoleApp() {
  installFatalHooks();
  return (
    <StrictMode>
      {/* 语言沿用宿主 localStorage 里已有的偏好（桌面主窗口会写入），不传 initialLocale。 */}
      <ZCodeIntlProvider broadcastService={broadcastStub}>
        <PlatformProvider platform={platform}>
          <StoreProvider broadcastService={broadcastStub}>
            <TabStoreProvider>
              <TooltipProvider>
                <DiffsWorkerPoolProvider>
                  <LucideProvider strokeWidth={1.5}>
                    <App />
                  </LucideProvider>
                </DiffsWorkerPoolProvider>
              </TooltipProvider>
            </TabStoreProvider>
          </StoreProvider>
        </PlatformProvider>
      </ZCodeIntlProvider>
    </StrictMode>
  );
}

type Theme = "light" | "dark" | "zai-light" | "zai-dark" | "system";

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
}

/** 主题引导：与 packages/desktop 的 resource-manager.tsx 同一套规则，读 localStorage 的 zcode-theme。 */
export function applyStoredTheme(): void {
  const savedTheme = (localStorage.getItem("zcode-theme") as Theme | null) ?? "zai-dark";
  const resolvedTheme = resolveTheme(savedTheme);
  const appliedTheme =
    savedTheme === "system"
      ? resolvedTheme === "dark"
        ? "zai-dark"
        : "zai-light"
      : savedTheme === "dark"
        ? "zai-dark"
        : savedTheme === "light"
          ? "zai-light"
          : savedTheme;
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}
