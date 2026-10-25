/** Locale-owned copy for linked Bot and group automation catalogs. */
export const SCHEDULE_NS = 'katcats.schedules'

/** Simplified Chinese task-list copy. */
export const scheduleZh = {
  title: '自动化任务',
  scopedTitle: '{name}的自动化任务',
  open: '查看自动化任务',
  refresh: '刷新',
  loading: '正在加载自动化任务…',
  failed: '自动化任务加载失败，请重试。',
  directoryFailed: '成员或群聊信息尚不可用，请稍后重试。',
  missing: '当前 Bot 或群聊已不可用。',
  empty: '还没有自动化任务。在聊天中告诉 Bot 需要定时完成什么。',
  noMatches: '没有符合条件的自动化任务。',
  search: '搜索任务或所属 Bot、群聊',
  statusFilter: '任务状态',
  all: '全部',
  active: '已启用',
  inactive: '已结束',
  bot: 'Bot · {name}',
  chat: '群聊 · {name}',
  unlinked: '未关联任务',
  count: '{count} 项任务',
  next: '下次：{time}',
  last: '计划时间：{time}',
  detail: '查看「{name}」',
  chatNotice: '群聊任务可在此查看；到期后在群内自动执行的能力尚未接通。',
}

/** Typed task-list dictionary keys. */
export type ScheduleKey = keyof typeof scheduleZh

/** English task-list copy with the same key vocabulary. */
export const scheduleEn: Record<ScheduleKey, string> = {
  title: 'Automations', scopedTitle: 'Automations for {name}', open: 'View automations', refresh: 'Refresh',
  loading: 'Loading automations…', failed: 'Could not load automations. Please try again.',
  directoryFailed: 'Bot or group details are unavailable. Please try again shortly.', missing: 'This Bot or group is unavailable.',
  empty: 'No automations yet. Tell a Bot what you would like scheduled in chat.', noMatches: 'No matching automations.',
  search: 'Search tasks, Bots or groups', statusFilter: 'Task status', all: 'All', active: 'Active', inactive: 'Ended',
  bot: 'Bot · {name}', chat: 'Group · {name}', unlinked: 'Unlinked tasks', count: '{count} tasks',
  next: 'Next: {time}', last: 'Scheduled: {time}', detail: 'View “{name}”',
  chatNotice: 'Group tasks are listed here. Scheduled execution in group chats is not connected yet.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Linked automation lists and their aggregate view. */
    'katcats.schedules': ScheduleKey
  }
}
