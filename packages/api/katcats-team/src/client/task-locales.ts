/** Locale-owned copy for durable group task handoffs and observed outcomes. */
export const TASKS_NS = 'katcats.tasks'

/** Chinese group task lifecycle copy. */
export const taskZh = {
  'task.record': '{from}交给{to}的群任务',
  'task.managerBadge': '群负责人',
  'task.handoff': '{from}交给{to}的内容',
  'task.toolHandoff': '交接记录',
  'task.copy': '复制',
  'task.copied': '已复制',
  'task.footnotes': '脚注',
  'task.owner': '你',
  'task.legacyCoordinator': '历史群协调',
  'task.unavailableMember': '已移除的成员',
  'task.instructions': '任务',
  'task.progress': '任务过程',
  'task.time': '记录时间：{time}',
  'task.recovered': '从保存记录恢复',
  'task.failure': '任务未完成：{message}',
  'task.unknownHint': '结果尚未确认，请检查已生成的内容后再决定是否重试。',
  'task.passedHint': '此成员选择不接话，未生成交付内容。',
  'state.queued': '已排队',
  'state.started': '已开始',
  'state.completed': '已完成',
  'state.passed': '已跳过',
  'state.failed': '失败',
  'state.cancelled': '派发前已取消',
  'state.unknown': '结果未确认',
} as const

/** Typed task-record vocabulary shared by both shipped languages. */
export type TaskKey = keyof typeof taskZh

/** English group task lifecycle copy. */
export const taskEn = {
  'task.record': 'Group task from {from} to {to}',
  'task.managerBadge': 'Group manager',
  'task.handoff': 'Content handed from {from} to {to}',
  'task.toolHandoff': 'Handoff record',
  'task.copy': 'Copy',
  'task.copied': 'Copied',
  'task.footnotes': 'Footnotes',
  'task.owner': 'You',
  'task.legacyCoordinator': 'Historical coordinator',
  'task.unavailableMember': 'Removed member',
  'task.instructions': 'Task',
  'task.progress': 'Task progress',
  'task.time': 'Recorded at {time}',
  'task.recovered': 'Restored from saved records',
  'task.failure': 'Task did not complete: {message}',
  'task.unknownHint': 'The outcome is unconfirmed. Check existing output before deciding whether to retry.',
  'task.passedHint': 'This member chose not to reply and produced no deliverable.',
  'state.queued': 'Queued',
  'state.started': 'Started',
  'state.completed': 'Completed',
  'state.passed': 'Passed',
  'state.failed': 'Failed',
  'state.cancelled': 'Cancelled before dispatch',
  'state.unknown': 'Outcome unconfirmed',
} satisfies Record<TaskKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Real task handoffs and their durable lifecycle, separate from generated member replies. */
    'katcats.tasks': TaskKey
  }
}
