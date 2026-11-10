/** Shared task archive labels for group settings and dispatch rooms. */
export const taskArchiveZh = {
  'archive.viewDetails': '查看任务详情', 'archive.copyGoal': '复制任务目标', 'archive.copyId': '复制任务 ID',
  'archive.open': '任务档案', 'archive.close': '关闭任务档案', 'archive.eyebrow': 'TASK RECORDS',
  'archive.subtitle': '目标、验收与下一步，集中留存',
  'archive.total': '已登记任务', 'archive.unblocked': '未标记阻塞', 'archive.blocked': '受阻任务',
  'archive.all': '全部', 'archive.openState': '已登记', 'archive.blockedState': '受阻',
  'archive.search': '搜索任务目标、负责人或任务 ID', 'archive.list': '已保存的任务',
  'archive.empty': '还没有任务档案', 'archive.emptyHint': '成员登记业务任务后，目标、验收条件与下一步会保存在这里',
  'archive.noMatch': '没有匹配的任务', 'archive.owner': '负责人', 'archive.formerOwner': '历史成员',
  'archive.goal': '任务目标', 'archive.stage': '已记录阶段', 'archive.next': '下一步', 'archive.criteria': '验收条件',
  'archive.blocker': '阻塞原因', 'archive.artifacts': '产物引用', 'archive.noArtifacts': '尚未登记产物',
  'archive.noCriteria': '尚未登记验收条件', 'archive.revision': '修订', 'archive.messages': '关联消息',
  'archive.id': '任务 ID', 'archive.synced': '随保存同步', 'archive.stale': '连接中断 · 显示最后同步记录',
  'archive.scope': '展示最后一次保存的业务任务；执行动态请查看调度室。成员结束一轮回复，不代表任务已完成或已验收。',
}

/** English counterparts; key parity is checked by TypeScript. */
export const taskArchiveEn: Record<keyof typeof taskArchiveZh, string> = {
  'archive.viewDetails': 'View task details', 'archive.copyGoal': 'Copy task goal', 'archive.copyId': 'Copy task ID',
  'archive.open': 'Task records', 'archive.close': 'Close task records', 'archive.eyebrow': 'TASK RECORDS',
  'archive.subtitle': 'Keep the goal, evidence and next step in view',
  'archive.total': 'Recorded tasks', 'archive.unblocked': 'Not marked blocked', 'archive.blocked': 'Blocked tasks',
  'archive.all': 'All', 'archive.openState': 'Recorded', 'archive.blockedState': 'Blocked',
  'archive.search': 'Search goals, owners or task IDs', 'archive.list': 'Saved tasks',
  'archive.empty': 'No task records yet', 'archive.emptyHint': 'Goals, acceptance criteria and next steps appear here when a member records business work',
  'archive.noMatch': 'No matching tasks', 'archive.owner': 'Owner', 'archive.formerOwner': 'Former member',
  'archive.goal': 'Task goal', 'archive.stage': 'Recorded stage', 'archive.next': 'Next step', 'archive.criteria': 'Acceptance criteria',
  'archive.blocker': 'Blocker', 'archive.artifacts': 'Artifact references', 'archive.noArtifacts': 'No artifacts recorded',
  'archive.noCriteria': 'No acceptance criteria recorded', 'archive.revision': 'Revision', 'archive.messages': 'Linked messages',
  'archive.id': 'Task ID', 'archive.synced': 'Updates when saved', 'archive.stale': 'Disconnected · Last synced records',
  'archive.scope': 'Shows the last saved business task. See the dispatch room for execution activity. An ended member turn does not mean the task is complete or accepted.',
}

/** Copy accepted by the shared archive without coupling its callers' locale namespaces. */
export type TaskArchiveTranslate = (key: keyof typeof taskArchiveZh) => string
