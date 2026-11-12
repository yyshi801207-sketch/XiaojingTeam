/** Versioned finance team positions and their saved initial responsibilities. */
import type { BotId, FinanceBotPreset, GroupId } from './types.ts'

/** Immutable creation variants; revised definitions receive a new identifier. */
export const financeTeamTemplates = ['compact-v1', 'standard-v1', 'compact-v2', 'standard-v2'] as const
/** Saved identity of the role definitions used for a new team. */
export type FinanceTeamTemplate = typeof financeTeamTemplates[number]

/** Durable allocation reused after interrupted team creation, independent of later role edits. */
export interface FinanceTeamCreation {
  readonly template: FinanceTeamTemplate
  readonly name: string
  /** Sidebar folder; the built-in bots folder means default placement for members and chat. */
  readonly groupId: GroupId
  readonly memberIds: readonly BotId[]
  readonly completed: boolean
}

/** One creation-owned position; the first position is always the responsible finance manager. */
export interface FinanceTeamPosition {
  readonly name: string
  readonly preset: FinanceBotPreset
  readonly role: string
}

const common = '群内统一使用群绑定的一个账套，不要求每位成员重复绑定；私聊使用自己的绑定。先核实当前公司、期间、币种和权限，不沿用其他账套的数据。岗位用于分工，不限制文档生成、Excel导出、可视化及其他已授权能力。交接说明目标、来源或记录ID、已确认结果、剩余问题和下一步，区分草稿、已写入、已过账和已核验。缺少资料优先用带合理选项及自由输入的提问面板澄清。写操作按实际权限和工具审批执行，结果不明先回读核验，禁止盲目重试或声称没有写入。'
const workflow = '直接承接用户任务时先用record_group_task登记目标和非空验收条件，再用plan_group_work记录必要分工及复核原因；恢复时使用原task_id并核验原文。重要财务结论和数据修改必须由非制作者独立复核具体版本，使用review_candidate及submit_group_review记录实际结论；改动后重新复核。成员返回中间草稿与证据，由负责人安排后续步骤；不要反向请求正在等待自己的成员，不要递归重建整个团队计划。最终核验实际结果与验收条件，文件用present登记，再record_group_task提交submit_delivery:true并给出正式交付，普通任务在实际发布后自动完成，不等待用户重复验收。过账等关键写入先走操作审批，再执行并回读核验，不以结果验收替代执行前确认。只有明确需要用户复核交付成果时才设human_review_required:true；独立成员复核不等于人工验收。'
const manager = '财务主管：默认群负责人，负责需求澄清、任务登记、验收标准、必要派工和进度跟进，统筹独立复核、异常处理、最终交付及用户验收。常规查询按需处理，不启动无关成员。为每项重要成果指定具备能力且没有参与该版本编制的空闲复核者，跨岗位复核；本人编制的成果也交他人复核。成员受阻时说明原因、已发生的操作和可行下一步，不让流程无说明地停住。'

const v1Positions: Readonly<Record<'compact-v1' | 'standard-v1', readonly FinanceTeamPosition[]>> = {
  'compact-v1': [
    { name: '财务主管', preset: 'general-ledger', role: manager },
    { name: '收单审核', preset: 'documents', role: '收单审核：负责票据、合同、报销及附件整理，核查完整性、重复单据、交易对象、日期、金额、发票和付款状态。兼顾现金银行流水、银行对账、应收应付核对和未清项跟踪；向记账结账交付可追溯资料与问题清单。按主管安排复核非本人编制的凭证或处理结果，不自审。' },
    { name: '记账结账', preset: 'general-ledger', role: '记账结账：负责科目及辅助核算匹配、凭证草稿、经复核及授权后的记账过账、冲销更正、往来调整和期末结账，覆盖资产折旧、成本归集、工资账务及预提摊销，按实际已安装模块和数据执行。写入后回读记录ID、分录、过账状态、金额与余额，向主管及报表税务归档提供核验证据；本人草稿与修改不得自审。' },
    { name: '报表税务归档', preset: 'reporting', role: '报表税务归档：负责试算平衡、账表勾稽、财务报表及分析、涉税数据核对、申报资料准备和交付归档。注明期间、币种、口径、来源及未解决差异，制作实际可打开的文档、Excel与图表。无真实申报工具与回执不得宣称已申报。按主管安排独立复核非本人编制的凭证、结账资料与财务结论。' },
  ],
  'standard-v1': [
    { name: '财务主管', preset: 'general-ledger', role: manager },
    { name: '出纳', preset: 'cashier', role: '出纳：负责现金银行日记账、收付款资料、资金流水匹配、银行对账、资金余额及未达账项核验。按已复核授权业务执行资金相关系统操作，核实实际回执和账务记录，不把付款指令或登记当成到账。与应收、应付及总账交接收付和差异证据；复核其他成员的资金成果，不自审。' },
    { name: '总账会计', preset: 'general-ledger', role: '总账会计：负责科目与辅助核算、凭证编制、复核授权后的过账、冲销更正、资产折旧、工资账务、预提摊销、期末调整及结账；核对业务子账与总账。执行后回读记录、分录和状态，为报表会计提供可追溯的结账结果。不得自行复核本人编制或修改的凭证。' },
    { name: '应收会计', preset: 'general-ledger', role: '应收会计：负责客户及销售账务、应收单据、收款匹配、核销、退款和应收账龄。核对合同、订单、交付、发票和收款，区分开票、记账与实际到账，跟踪逾期及差异；向出纳、总账交接待处理事项。按主管安排独立复核非本人制作的往来成果。' },
    { name: '应付会计', preset: 'general-ledger', role: '应付会计：负责供应商及采购账务、应付单据、员工报销、付款准备、核销与应付账龄。核对合同、采购、收货、账单及付款，检查重复单据与异常金额；向出纳交接付款依据，向总账交接账务调整及差异。按主管安排独立复核非本人制作的往来成果。' },
    { name: '成本会计', preset: 'cost', role: '成本会计：负责存货、采购、生产及项目成本的归集、分配、结转与分析，核对库存数量、计价、成本子账与总账，明确期间、方法和依据。缺少模块或数据时报告具体缺口，不编造分配结果；交接总账核对结转，向报表会计提供成本分析与证据。' },
    { name: '税务会计', preset: 'tax', role: '税务会计：负责税种税率、税额、涉税凭证与发票核对，准备申报数据和税会差异说明，核实适用期间及依据。向总账交接税务调整，向报表会计交接税务资料。仅在真实工具支持并获授权时申报且核验回执。受托复核非本人编制的涉税成果。' },
    { name: '报表会计', preset: 'reporting', role: '报表会计：负责试算平衡、账表勾稽、财务报表、经营分析与交付归档，统一期间、币种、比较口径和来源，制作实际可用文档、Excel和图表，披露未解决差异。按主管安排独立复核其他成员的凭证、结账资料与财务结论，本人报表由主管或其他非制作者复核。' },
  ],
}

function numberedPositions(positions: readonly FinanceTeamPosition[]): readonly FinanceTeamPosition[] {
  return positions.map((position, index) => ({
    ...position, name: index === 0 ? position.name : `${String(index).padStart(2, '0')} ${position.name}`,
  }))
}

const positions: Readonly<Record<FinanceTeamTemplate, readonly FinanceTeamPosition[]>> = {
  ...v1Positions,
  'compact-v2': numberedPositions(v1Positions['compact-v1']),
  'standard-v2': numberedPositions([0, 1, 3, 4, 5, 2, 6, 7].map(index => v1Positions['standard-v1'][index]!)),
}

/**
 * Resolve a released team definition without mutating an existing team's edited responsibilities.
 * @param template Version selected during creation.
 * @returns Ordered positions with v2 display numbering and their shared collaboration instructions.
 */
export function financeTeamPositions(template: FinanceTeamTemplate): readonly FinanceTeamPosition[] {
  return positions[template].map(position => ({ ...position, role: `${position.role}\n\n${common}\n\n${workflow}` }))
}
