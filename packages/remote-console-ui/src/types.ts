export interface ConversationTarget {
  workspacePath: string;
  /** null 表示新建任务（draft 会话，首条消息发出后由 onSessionCreated 拿到真实 sessionId）。 */
  taskId: string | null;
  title?: string;
}
