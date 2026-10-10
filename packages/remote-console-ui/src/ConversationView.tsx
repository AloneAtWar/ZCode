// 会话视图：relay bridge → IMessagePassingProtocol → IServiceAccessor →
// 会话 transport + SessionDataLayer → V4ConversationContext → SessionPane。
// 装配方式照抄 packages/ui/src/v4/V4ConversationContext.tsx 的
// ReadyV4ConversationProvider（不走 V4ConversationProvider 的 workspace 解析链）。
import { useEffect, useState } from "react";
import { connectViaProtocol } from "@zcode/client";
import type { RelayState } from "@zcode/relay-client";
import {
  AssistantCodeCommentFeatureProvider,
  CodingPlanUpgradeDialogProvider,
  createAgentConversationTransport,
  ServiceProvider,
  SessionDataLayer,
  SessionPane,
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@zcode/ui/replay";
import { Button } from "@zcode/ui/replay";
import { getOrCreateRelayDevice } from "./deviceCache.js";
import type { StoredDevice } from "./deviceStore.js";
import type { ConversationTarget } from "./types.js";

type Services = ReturnType<typeof connectViaProtocol>;

interface ConversationBundle {
  services: Services;
  value: V4ConversationContextValue;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface ConversationViewProps {
  device: StoredDevice;
  target: ConversationTarget;
  onBack: () => void;
}

export function ConversationView({ device, target, onBack }: ConversationViewProps) {
  const [bundle, setBundle] = useState<ConversationBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 新建任务（target.taskId === null）时是 draft 会话：首条消息发出后
  // SessionPane 经 onSessionCreated 回传真实 sessionId，此处原地接管。
  const [sessionId, setSessionId] = useState<string | null>(target.taskId);
  const [relayState, setRelayState] = useState<RelayState>(
    () => getOrCreateRelayDevice(device).state,
  );

  useEffect(() => {
    const relayDevice = getOrCreateRelayDevice(device);
    relayDevice.onStateChanged(setRelayState);
    let cancelled = false;
    let layer: SessionDataLayer | null = null;
    let bridgeDisposed = false;
    const bridgePromise = relayDevice.openBridge({
      workspaceKey: target.workspacePath,
      ...(target.taskId ? { taskId: target.taskId } : {}),
    });
    bridgePromise
      .then((bridge) => {
        if (cancelled) {
          bridge.dispose();
          return;
        }
        const services = connectViaProtocol(bridge.protocol);
        const workspacePath =
          typeof bridge.info["workspacePath"] === "string"
            ? (bridge.info["workspacePath"] as string)
            : target.workspacePath;
        const workspaceIdentity =
          typeof bridge.info["workspaceIdentity"] === "string"
            ? (bridge.info["workspaceIdentity"] as string)
            : undefined;
        const transport = createAgentConversationTransport(services.zcodeAgentService, {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        layer = new SessionDataLayer({ transport });
        const value = {
          layer,
          sendCommand: (envelope) => transport.sendCommand(envelope),
          fileChanges: (params) => transport.fileChanges(params),
          fileRewindPreview: (params) => transport.fileRewindPreview(params),
          workflowRunEvents: (params) => transport.workflowRunEvents(params),
          workflowRunArtifacts: (params) => transport.workflowRunArtifacts(params),
          workflowRunArtifactData: (params) => transport.workflowRunArtifactData(params),
          workflowRunArtifactRead: (params) => transport.workflowRunArtifactRead(params),
          workflowRunWorkspace: (params) => transport.workflowRunWorkspace(params),
          workflowRunNodeResult: (params) => transport.workflowRunNodeResult(params),
          workflowRuns: (params) => transport.workflowRuns(params),
          attachmentPut: (params, options) => transport.attachmentPut(params, options),
          attachmentRead: (params) => transport.attachmentRead(params),
          attachmentReadRange: (params) => transport.attachmentReadRange(params),
          onRuntimeRestart: (listener) => transport.onRuntimeRestart(listener),
          ...(transport.onRuntimeLifecycle
            ? {
                onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
                  transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
              }
            : {}),
        } satisfies V4ConversationContextValue;
        setBundle({
          services,
          value,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      layer?.dispose();
      if (!bridgeDisposed) {
        bridgeDisposed = true;
        void bridgePromise.then((bridge) => bridge.dispose()).catch(() => {});
      }
    };
  }, [device, target]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← 任务列表
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {target.title ?? sessionId ?? "新任务"}
          </div>
          <div className="truncate text-xs text-muted-foreground">{target.workspacePath}</div>
        </div>
        {relayState === "kicked" ? (
          <span className="rounded-full bg-red-500/10 px-2.5 py-1 text-xs text-red-400">
            已被其他终端踢下线
          </span>
        ) : relayState !== "paired" ? (
          <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs text-amber-400">
            连接中…
          </span>
        ) : null}
      </header>
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="flex h-full items-center justify-center">
            <p className="max-w-lg rounded-md border border-destructive/50 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              打开会话失败：{error}
            </p>
          </div>
        ) : bundle ? (
          <ServiceProvider services={bundle.services}>
            <AssistantCodeCommentFeatureProvider>
              <CodingPlanUpgradeDialogProvider>
                <V4ConversationContext.Provider value={bundle.value}>
                  <SessionPane
                    paneId="main"
                    sessionId={sessionId}
                    workspacePath={bundle.workspacePath}
                    onSessionCreated={setSessionId}
                    {...(bundle.workspaceIdentity
                      ? { workspaceIdentity: bundle.workspaceIdentity }
                      : {})}
                  />
                </V4ConversationContext.Provider>
              </CodingPlanUpgradeDialogProvider>
            </AssistantCodeCommentFeatureProvider>
          </ServiceProvider>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            正在建立工作区桥接…
          </div>
        )}
      </div>
    </div>
  );
}
