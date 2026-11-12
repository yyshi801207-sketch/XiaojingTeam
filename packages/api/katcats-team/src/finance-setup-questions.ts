/** One-question-at-a-time intake for the private ledger setup assistant. */
import type { AskUserQuestionItem, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { z } from 'zod'

type SetupKind = 'fresh' | 'migration'
type Ask = (question: AskUserQuestionItem) => Promise<AskUserQuestionAnswer>

const countryOptions = [
  ['中国大陆 CN', 'CN', 'CNY'],
  ['中国香港 HK', 'HK', 'HKD'],
  ['美国 US', 'US', 'USD'],
  ['日本 JP', 'JP', 'JPY'],
  ['新加坡 SG', 'SG', 'SGD'],
] as const

const currencyNames: Readonly<Record<string, string>> = {
  CNY: '人民币', HKD: '港元', USD: '美元', JPY: '日元', SGD: '新加坡元', EUR: '欧元', GBP: '英镑',
}
const countryNames: Readonly<Record<string, string>> = { 中国: 'CN', 中国大陆: 'CN', 中国香港: 'HK', 香港: 'HK', 美国: 'US', 日本: 'JP', 新加坡: 'SG' }
const openingDate = z.iso.date()
const companyName = z.string().trim().min(1).max(100)

function validCode(input: string, length: number): string | undefined {
  const code = input.trim().toUpperCase()
  return code.length === length && /^[A-Z]+$/.test(code) ? code : undefined
}

function countryCode(input: string): string | undefined {
  return countryOptions.find(([label]) => label === input)?.[1]
    ?? (Object.hasOwn(countryNames, input) ? countryNames[input] : undefined)
    ?? validCode(input, 2)
}

function currencyCode(input: string): string | undefined {
  return Object.entries(currencyNames).find(([code, label]) => input === label || input === label + ' ' + code)?.[0]
    ?? validCode(input, 3)
}

function accountingDate(input: string): string | undefined {
  const value = input.match(/(?:^|\s)(\d{4}-\d{2}-\d{2})$/)?.[1]
  return openingDate.safeParse(value).success ? value : undefined
}

function dateOptions(now: Date): { label: string }[] {
  const today = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  return [{ label: '今天 ' + today },
    ...(today.endsWith('-01') ? [] : [{ label: '本月 1 日 ' + today.slice(0, 8) + '01' }])]
}

function setupKind(input: string): SetupKind | undefined {
  if (input === '全新启用账套' || input === 'fresh') return 'fresh'
  if (input === '从旧账迁移' || input === 'migration') return 'migration'
  return undefined
}

/** User-confirmed values returned with an incomplete intake and accepted when it resumes. */
export interface LedgerIntake {
  readonly name?: string
  readonly country_code?: string
  readonly currency_code?: string
  readonly opening_date?: string
  readonly setup_kind?: SetupKind
}

/** Complete intake before template and chart selection. */
export type CompleteLedgerIntake = Required<LedgerIntake>

/**
 * Show one question and keep prompting for malformed input until the user skips or provides a valid value.
 * @param ask Private Session's native question provider.
 * @param question The current prompt and optional suggestions.
 * @param parse Accepts a submitted value or returns undefined when it needs correction.
 * @param invalid Question text explaining the required input.
 * @returns The verified response, or undefined when the user skips.
 */
export async function ledgerAnswer<T>(
  ask: Ask, question: AskUserQuestionItem, parse: (value: string) => T | undefined, invalid: string,
): Promise<T | undefined> {
  let prompt = question
  for (;;) {
    const result = await ask(prompt)
    const answer = result.answers.find(item => item.id === question.id)
    const value = answer?.custom?.trim() || (answer?.selected.length === 1 ? answer.selected[0] : undefined)
    if (!value) return undefined
    const parsed = parse(value)
    if (parsed !== undefined) return parsed
    prompt = { ...question, question: invalid }
  }
}

/**
 * Fill missing company settings using separate, ordered native questions.
 * @param values Fields already explicitly confirmed for the current company.
 * @param ask Private Session's native question provider.
 * @param now Local date used only to display opening-date suggestions.
 * @returns Confirmed fields with a completed or paused outcome.
 */
export async function collectLedgerIntake(
  values: LedgerIntake, ask: Ask, now: Date,
): Promise<{ readonly status: 'complete'; readonly values: CompleteLedgerIntake }
  | { readonly status: 'paused'; readonly values: LedgerIntake }> {
  const input: { -readonly [K in keyof LedgerIntake]: LedgerIntake[K] } = {}
  const name = (value: string) => {
    const result = companyName.safeParse(value)
    return result.success ? result.data : undefined
  }
  const legalName = (values.name === undefined ? undefined : name(values.name)) ?? await ledgerAnswer(ask, {
    id: 'ledger-company-name', header: '公司名称', question: '请输入要建账的公司法定全称。',
  }, name, '请输入 1 至 100 个字符的公司法定全称。')
  if (legalName === undefined) return { status: 'paused', values: input }
  input.name = legalName

  const country = (values.country_code === undefined ? undefined : countryCode(values.country_code)) ?? await ledgerAnswer(ask, {
    id: 'ledger-country', header: '国家或地区', question: '这家公司注册在哪个国家或地区？',
    options: countryOptions.map(([label]) => ({ label })),
  }, countryCode, '请选择国家或地区，或输入两位国家代码，例如 CN。')
  if (country === undefined) return { status: 'paused', values: input }
  input.country_code = country

  const preferred = countryOptions.find(([, code]) => code === country)?.[2]
  const currencies = [...new Set([...(preferred === undefined ? [] : [preferred]), 'CNY', 'USD', 'EUR'])]
  const currency = (values.currency_code === undefined ? undefined : currencyCode(values.currency_code)) ?? await ledgerAnswer(ask, {
    id: 'ledger-currency', header: '记账本位币', question: '请选择这套账的记账本位币。',
    options: currencies.map(code => ({ label: currencyNames[code] + ' ' + code })),
  }, currencyCode, '请选择一种本位币，或输入三位币种代码，例如 CNY。')
  if (currency === undefined) return { status: 'paused', values: input }
  input.currency_code = currency

  const date = (values.opening_date === undefined ? undefined : accountingDate(values.opening_date)) ?? await ledgerAnswer(ask, {
    id: 'ledger-opening-date', header: '账套启用日期', question: '从哪一天开始使用这套账？',
    options: dateOptions(now),
  }, accountingDate, '请选择日期，或输入 YYYY-MM-DD 格式的有效日期，例如 2026-01-01。')
  if (date === undefined) return { status: 'paused', values: input }
  input.opening_date = date

  const kind = (values.setup_kind === undefined ? undefined : setupKind(values.setup_kind)) ?? await ledgerAnswer(ask, {
    id: 'ledger-setup-kind', header: '建账类型', question: '这次是全新启用，还是从旧账迁移？',
    options: [{ label: '全新启用账套' }, { label: '从旧账迁移', description: '先确认期初余额和未清往来，再安排迁移。' }],
  }, setupKind, '请从「全新启用账套」和「从旧账迁移」中选择。')
  if (kind === undefined) return { status: 'paused', values: input }
  return { status: 'complete', values: { name: legalName, country_code: country, currency_code: currency, opening_date: date, setup_kind: kind } }
}
