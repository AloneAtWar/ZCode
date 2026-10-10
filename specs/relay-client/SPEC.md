# relay-client 模块 Spec

## 目标与产品规则

为"控制端"应用提供连接**未修改的官方 ZCode 桌面端**的协议栈。被控端（桌面 App）
主动拨出到 z.ai relay（`wss://<endpoint>/ws`）；控制端凭远程链接
（`https://<endpoint>/remote/v4?sid=…&hash=…&t=…&mid=…&name=…`）以 `terminal`
角色接入同一 relay 会话。

- 远程链接即设备凭据：只在控制端本地存储与使用，不上云、不写日志。
- 同一设备同时只允许一个 terminal 在线；被踢（4009 / KICKED）必须显式呈现，
  不静默重连抢占。
- 协议私有且随官方演进：所有 wire 字段解析失败时按"未知字段忽略、缺字段报错"
  处理，不因新增字段崩溃。

## 分层与状态所有者

```text
RelayClient        拥有：ws 连接、auth 配对状态机、心跳、重连退避、出站 payload 队列
RemoteClient       拥有：relay payload 级请求/响应匹配、bootstrap/工作区列表、
                        bridge 生命周期（open/reconnect/degraded 恢复）
RpcFrameTransport  拥有：每条 bridge 的 rpc-frame 分片/组装、crc32 校验、ack（含 identity）
BridgeProtocol     适配：RpcFrameTransport ↔ IMessagePassingProtocol（@zcode/rpc），
                        供第一方 ChannelClient / RemoteServiceAccess 直接消费
```

事件顺序（成功路径）：
`auth_init → auth_challenge → auth_response → auth_ack(pair_status=matched)
→ bootstrap-request/response → workspace-bridge-open → workspace-bridge-ready
→ Channel Initialize → helloConversationV4 → initializeConversationV4 → subscribe…`

幂等与重试边界：

- relay 断线后自动重连（指数退避 1s→15s）；恢复配对后由 RemoteClient
  重新打开 bridge（携带递增 `bridgeGeneration` 与原 `recoveryId`），
  上层订阅由消费方（会话数据层）负责重订阅。
- `rpc-frame-ack` 与出站 `rpc-frame` 必须携带完整 identity
  （`bridgeSessionId` + `bridgeGeneration` + 可选 `recoveryId`）；
  缺 `bridgeGeneration` 的 ack 会被桌面端忽略并重传，最终触发
  `bridge-degraded: rpc-transport-fault`（PoC 实证）。
- 配对期间（非 paired 状态）的出站 payload 排队，matched 后按序 flush。

## 接口（公共入口 `packages/relay-client/src/index.ts`）

- `parseRemoteConnectionUrl(raw)` → `RemoteConnectionParams`（非法链接返回 null）
- `connectRelayDevice(rawOrParams, options?)` → `RelayDevice`
  - `state` / `onStateChanged`：relay 状态机（含 kicked/error 原因）
  - `bootstrap()` → 桌面版本、当前视图、工作区列表（`workspaces`）与任务列表
  - `listWorkspaces()` → 工作区列表
  - `openBridge({ workspaceKey, taskId? })` → `RelayBridge`
  - `dispose()`
- `RelayBridge`
  - `protocol: IMessagePassingProtocol`（交给 `@zcode/client` 的
    `connectViaProtocol` 得到 `IServiceAccessor`）
  - `degraded` / `onRecovered`：bridge 降级与恢复事件
  - `dispose()`

## 验收场景

1. 用真实远程链接连接：`connectRelayDevice` 进入 `paired`，`bootstrap()`
   返回被控端版本与任务列表。
2. 开桥后 `connectViaProtocol(bridge.protocol)` 能调用
   `zcode-agent.helloConversationV4` 并拿到 `connectionId`。
3. 订阅会话后持续 60s 无 `rpc-transport-fault`、无重复 Initialize。
4. 被控端被其他终端抢占时，控制端收到 kicked 状态且不再自动重连。

## 边界

- 本包不含 UI、不持久化设备列表（控制端应用负责）。
- 不实现桌面端 `desktop-continuous` 角色；只做 `terminal`（web-remote-replayable）。

# remote-console 控制端 Spec（packages/remote-console-ui + apps/remote-console）

## 目标与产品规则

控制端 UI 本体在共享包 `packages/remote-console-ui`（`@zcode/remote-console-ui`），
宿主是 `apps/remote-console`：浏览器 dev 版薄壳（vite，端口 5180），只做样式引入、
主题引导和 `createRoot`。

功能：添加设备（粘贴远程链接）→ 连接配对 → 按工作区浏览任务列表 →
打开既有会话收发消息 → 工作区上「＋ 新建任务」开草稿会话，首条消息发出后
经 `onSessionCreated` 原地接管真实 sessionId。复用 `@zcode/ui` 第一方组件
（`SessionPane` 及 Provider 栈），传输层由 `@zcode/relay-client` 提供。

- 设备列表持久化在本机 localStorage（`zcode-remote-devices`），key 为设备 sid；
  重复添加同设备视为凭据轮换并覆盖链接。桌面窗口（5174 origin）与浏览器版
  （5180 origin）的 localStorage 各自独立。
- `RelayDevice` 实例模块级缓存：页面切换不销毁连接，仅显式删除设备时 dispose。
- 会话页离开即 dispose 该 bridge 与 SessionDataLayer；relay 设备连接保留。
- 新建任务走 draft 会话：`openBridge` 不带 taskId，`SessionPane sessionId=null`；
  header 标题优先级 `target.title ?? sessionId ?? "新任务"`。
- 工作区分组以 `bootstrap().workspaces` 为全量主轴（含无任务工作区），
  任务按 `workspacePath` 归入；key 规则沿用 `workspaceIdentity?.trim() || workspacePath`。

## 装配（与 Root.tsx / ReadyV4ConversationProvider 对齐）

```text
index.tsx RemoteConsoleApp（无 services 依赖）
  ZCodeIntlProvider(沿用 localStorage 语言偏好) > PlatformService(空实现)
  > StoreProvider(broadcast 本地空实现) > TabStoreProvider > TooltipProvider
  > DiffsWorkerPoolProvider > LucideProvider

ConversationView（services 依赖层，必须在 ServiceProvider 内）
  openBridge → connectViaProtocol → IServiceAccessor
  ServiceProvider > AssistantCodeCommentFeatureProvider > CodingPlanUpgradeDialogProvider
  > V4ConversationContext(手工装配 createAgentConversationTransport + SessionDataLayer)
  > SessionPane
```

注意：`CodingPlanUpgradeDialogProvider` 等服务消费型 Provider 不能放全局层
（全局层没有 ServiceProvider）；不走 `V4ConversationProvider`（它会走
remoteWorkspaceSessionStore 解析链并永远 remote-waiting）。

Tailwind 约束：唯一起作用的扫描源是 `@zcode/ui/styles.css`（`source(".")` 只扫
packages/ui/src），remote-console-ui 的 utility class 必须同样出现在
packages/ui/src 源码中，否则静默失效。

## 验收场景

1. 粘贴链接添加设备 → 连接 → 显示「已配对」、桌面版本与按工作区分组的任务列表。
2. 点开任务 → 会话时间线（思考/终端/文件变更）完整渲染。
3. composer 发送消息 → 被控端真实执行 → 回复流式回到控制端时间线。
4. 工作区上「＋ 新建任务」→ 草稿会话 → 发首条消息 → 被控端创建真实任务，
   header 接管新 sessionId，返回任务列表可见该任务。
5. 其他终端抢占同一链接时显示被踢横幅，不静默抢占。

# 桌面主界面原生集成 Spec（packages/desktop renderer）

## 目标与产品规则

在 fork 桌面 App 主界面原生接入 relay 远程控制（不是独立窗口、不是网页）：
侧栏「远程控制」按钮打开 `RelayDeviceDialog`（`@zcode/ui`），粘贴远程链接添加
被控设备 → 列出被控端打开的工作区 → 打开后远程工作区以普通远程 tab 出现在
侧栏，任务用标准 `SessionPane` 渲染、可新建对话，体验与 SSH/WSL 远程工作区一致。

关键设计：bridge 的 RPC 面来自被控桌面自己的 Host attachment，不经本机
main/host，因此**不创建 RemoteTarget / logical session**，而是参照手机 web relay
的做法，由 renderer 直接把服务注册进 `remoteWorkspaceSessionStore`
（store 的 `session.target` 本就可选）。注册后任务分片订阅与
`V4ConversationProvider` 全部走标准远程解析链。

## 分层与状态所有者

```text
shared/platform.ts               IPlatformService 可选方法 ×5（list/add/remove/
                                 listWorkspaces/openWorkspace）+ 摘要类型；web/stub
                                 不实现 → RelayDeviceDialog 自行隐藏（能力探测入口）
relayRemoteController.ts         拥有：设备/工作区持久化（localStorage
（packages/desktop renderer）       zcode-relay-remote-devices / zcode-relay-remote-workspaces）、
                                 RelayDevice 连接缓存、bridge 生命周期、
                                 register/bindRemoteWorkspacePath、启动恢复重建桥接
desktopPlatform.ts               5 个方法的 renderer 直连委托（不经 IPC/preload）
RelayDeviceDialog.tsx (@zcode/ui)  设备列表/添加/移除 → 工作区列表 → openRelayRemoteWorkspace
                                 成功后 useTabStore.addTab(workspacePath, {remoteSessionId})
```

- sessionId 稳定派生：`relay-${deviceId}-${crc32Hex(workspaceKey)}`，
  供 tab 跨重启恢复；启动时按持久化记录重建桥接并重新注册。
- `registerRemoteWorkspaceSession` 的 services 用
  `buildRemoteWorkspaceSessionServices(base, connectViaProtocol(bridge.protocol))`
  合并；`bindRemoteWorkspacePath(workspacePath, sessionId)` 建立路径→会话映射。
- 远程链接即凭据：只存本机 localStorage，不写日志、不上云。

## 验收场景

1. 侧栏点「远程控制」→ 粘贴链接 → 设备出现在列表。
2. 点设备 → 列出被控端当前打开的工作区。
3. 打开工作区 → 侧栏出现该工作区 tab，任务分片列出被控端任务。
4. 打开任务 → 标准会话页渲染，可收发消息；「新建任务」可在被控端创建真实任务。
5. 重启 App 后远程 tab 随持久化桥接恢复，不永远 remote-waiting。
6. 移除设备 → 断开其全部桥接并清理持久化记录。

## 「打开其他目录」（被控端未打开的工作区）

官方被控端拒绝为未打开的工作区开桥（PoC 实证：`workspace-bridge-error`
“目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge”），relay 指令面
也没有 openWorkspace 类消息（官方 web 端与 ZLinker 同样不支持）。但任一已打开
工作区的桥接上 `terminal` channel 可用（与被控端任务内终端同一能力面），据此
实现借道打开（PoC 实证全链路 4 秒完成）：

1. 借 anchor（任一已打开工作区）桥接创建 pty；
2. `Get-Process` 查到被控端 `ZCode.exe` 路径（按设备缓存）；
3. `Start-Process ZCode.exe --open-workspace <path>` —— 走 second-instance
   通道 `handleOpenWorkspacePath`，**无确认弹窗**（`zcode://workspace/open`
   deep link 有确认弹窗，不可用）；
4. 轮询 bootstrap 直到该目录出现在被控端工作区列表（上限 45s）；
5. 按普通流程开桥、注册、addTab。

弹窗内提供手动路径输入 + 被控端最近项目候选（经 anchor 桥读取
`settingService.get().recentProjects`）。被控端没有任何已打开工作区时该流程
不可用（无 anchor 桥），明确报错。

7. 「打开其他目录」→ 输入被控端路径（或点最近项目）→ 被控端弹出该目录窗口 →
   本端自动接入为远程 tab；路径已在被控端打开时直接接入不重复弹窗。
