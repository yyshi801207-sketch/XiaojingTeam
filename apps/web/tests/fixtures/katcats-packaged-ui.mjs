/** Real-browser assertions against an isolated, unchanged packaged Katcats Host. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron } from 'playwright'

const redact = text => String(text).replace(/([?&]token=)[^\s&"'<>]+/gu, '$1[synthetic-redacted]')

/**
 * Redact only this serial smoke's Host stdout.
 * @returns the mandatory restore callback.
 */
export function redactPackagedSmokeOutput() {
  const write = process.stdout.write.bind(process.stdout)
  let buffered = ''
  process.stdout.write = (chunk, encoding, callback) => {
    buffered += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const end = buffered.lastIndexOf('\n')
    if (end >= 0) {
      write(redact(buffered.slice(0, end + 1)))
      buffered = buffered.slice(end + 1)
    }
    const done = typeof encoding === 'function' ? encoding : callback
    done?.()
    return true
  }
  return () => {
    process.stdout.write = write
    if (buffered !== '') write(redact(buffered))
  }
}

/**
 * Verify main/private/group product UI and a paused queue without requesting model output.
 * @param options - own Host login, output directory, browser executable and scrubbed environment.
 * @returns browser evidence after real UI creation and an untouched composer in each scope.
 */
export async function verifyPackagedKatcatsBrowser({ loginUrl, directory, environment, electron }) {
  const origin = new URL(loginUrl).origin
  const pageErrors = [], consoleErrors = [], checks = [], composers = [], captureErrors = []
  const main = join(directory, 'browser-main.cjs')
  await writeFile(main, `const { app, BrowserWindow } = require('electron')\n`
    + `app.setPath('appData', ${JSON.stringify(join(directory, 'browser-app-data'))})\n`
    + `app.setPath('userData', ${JSON.stringify(join(directory, 'browser-user-data'))})\n`
    + `app.setPath('sessionData', ${JSON.stringify(join(directory, 'browser-session-data'))})\n`
    + `app.commandLine.appendSwitch('lang', 'zh-CN')\n`
    + `app.commandLine.appendSwitch('disable-background-networking')\n`
    + `app.whenReady().then(() => { const window = new BrowserWindow({ show: false, width: 1440, height: 1080,
      webPreferences: { contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
      window.loadURL('about:blank') })\n`
    + `app.on('window-all-closed', () => app.quit())\n`)
  const browser = await _electron.launch({ executablePath: electron, args: [main], env: environment, timeout: 30_000 })
  let page, before, after
  try {
    page = await browser.firstWindow()
    page.setDefaultTimeout(20_000)
    page.on('pageerror', error => pageErrors.push(redact(error.message)))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(redact(message.text())) })
    await browser.context().route('**/*', route => {
      const url = new URL(route.request().url())
      return url.origin === origin || ['data:', 'blob:', 'about:'].includes(url.protocol) ? route.continue() : route.abort()
    })
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForURL(origin + '/', { timeout: 20_000 })
    const probe = async () => {
      const response = await page.request.get(origin + '/katcats-packaged-ui-probe')
      assert.equal(response.status(), 200)
      return response.json()
    }
    before = await probe()
    await writeFile(join(directory, 'before.json'), JSON.stringify(before, null, 2) + '\n')
    const welcome = page.getByRole('dialog', { name: '初次使用说明', exact: true })
    await welcome.waitFor({ state: 'visible' })
    await welcome.getByRole('button', { name: '开始使用', exact: true }).click()
    await welcome.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Katcats', exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '创建新 Bot', exact: true }).first().waitFor({ state: 'visible' })
    checks.push('packaged product main Bot and primary create action are visible')
    assert.equal(before.productMode, '1')
    assert.equal(before.developmentModePresent, false)
    assert.deepEqual(before.services, { team: true, chats: true, memory: true })
    for (const id of ['katcats-team', 'katcats-chats', 'katcats-memory']) {
      const entry = before.entries.find(entry => entry.id === id)
      assert.equal(entry?.disabled, false)
      assert.equal(entry?.state, 2, id + ' must actually activate, not merely be enabled')
    }
    assert.equal(before.modelCalls, 0)
    assert.equal(before.bots, 1, 'Every smoke must start with only the fresh main Bot')
    assert.equal(before.chats, 0)
    const cleanComposer = async (kind, placeholder) => {
      const editor = page.getByRole('textbox', { name: placeholder, exact: true })
      await editor.waitFor({ state: 'visible' })
      assert.notEqual(await editor.getAttribute('data-composer-input'), null)
      assert.equal((await editor.innerText()).trim(), '')
      const seat = editor.locator('xpath=ancestor::*[@data-conversation-region="composer"][1]')
      assert.equal(await seat.getByText('标准模式', { exact: true }).count(), 0)
      assert.equal(await seat.getByText('选择一个工作区开始', { exact: true }).count(), 0)
      assert.equal(await seat.getByRole('button', { name: /工作区内修改|权限模式|选择模型|当前模型/u }).count(), 0)
      assert.equal(await seat.locator('[data-provider-id][data-model-id]').count(), 0)
      composers.push({ kind, placeholder, empty: true, legacyControls: false })
    }
    await cleanComposer('main', '主人，您想创建什么样的 Bot？')
    await page.getByRole('heading', { name: 'Katcats，Your personal AI team.', exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByText('我是 Katcats，Katcats.AI 的团队主管。', { exact: true }).count(), 0)
    assert.equal(await page.getByText(/^我的职责是帮你创建和配置 Bot 成员/u).count(), 0)
    checks.push('main Bot welcome preserves the tagline without the introduction or duties paragraphs')
    await page.getByRole('button', { name: '打开右侧边栏', exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]:visible').count(), 0)
    checks.push('fresh main Bot startup keeps the right sidebar collapsed')
    await page.screenshot({ path: join(directory, '01-main-bot.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Katcats', exact: true }).click()
    const mainSettings = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]:visible')
    await mainSettings.waitFor({ state: 'visible' })
    await mainSettings.getByRole('heading', { name: '操作权限', exact: true }).waitFor({ state: 'visible' })
    await mainSettings.getByText('工作区内修改', { exact: true }).waitFor({ state: 'visible' })
    const mainSession = await mainSettings.getAttribute('data-sidebar-right-session')
    assert.notEqual(mainSession, null)
    await page.waitForFunction(id => {
      const value = localStorage.getItem('dsh.sidebar-right.v1.' + id)
      return value !== null && JSON.parse(value).bySession[id].layout.expanded === true
    }, mainSession)
    const savedSettingsTab = await page.evaluate(id => Object.values(JSON.parse(
      localStorage.getItem('dsh.sidebar-right.v1.' + id)).bySession[id].layout.tabs)
      .find(tab => tab.kind === 'katcats-bot-settings'), mainSession)
    assert.notEqual(savedSettingsTab, undefined)
    checks.push('manual main Bot settings still open and expose its operation permissions')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await cleanComposer('main-reloaded', '主人，您想创建什么样的 Bot？')
    await page.waitForFunction(id => {
      const value = localStorage.getItem('dsh.sidebar-right.v1.' + id)
      return value !== null && JSON.parse(value).bySession[id].layout.expanded === false
    }, mainSession)
    await page.getByRole('button', { name: '打开右侧边栏', exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]:visible').count(), 0)
    const restoredSettingsTab = await page.evaluate(id => JSON.parse(
      localStorage.getItem('dsh.sidebar-right.v1.' + id)).bySession[id].layout.tabs, mainSession)
    assert.deepEqual(restoredSettingsTab[savedSettingsTab.id], savedSettingsTab)
    checks.push('reload collapses a previously saved expanded sidebar without deleting its settings tab')
    await page.screenshot({ path: join(directory, '01-main-bot-reloaded.png'), animations: 'disabled' })
    const names = ['打包验收文案助手', '打包验收复核助手']
    for (const name of names) {
      await page.getByRole('button', { name: '在「未分组」中创建 Bot', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '创建 Bot', exact: true })
      await dialog.getByLabel('名称', { exact: true }).fill(name)
      await dialog.getByRole('button', { name: '创建', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.getByRole('region', { name: '未分组', exact: true }).getByRole('button', { name, exact: true })
        .waitFor({ state: 'visible' })
      await cleanComposer('private', '主人，有什么需要我帮忙的？')
    }
    checks.push('original creation dialog saves two ordinary Bots in the Bot section')
    await page.screenshot({ path: join(directory, '02-ordinary-bots.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '创建群聊', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '创建群聊', exact: true })
    assert.equal(await dialog.getByLabel('每轮最多协作次数', { exact: true }).inputValue(), '16')
    const chatName = '打包验收协作群'
    await dialog.getByLabel('群聊名称', { exact: true }).fill(chatName)
    for (const name of names) await dialog.getByRole('checkbox', { name, exact: true }).check()
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByRole('region', { name: '群聊', exact: true }).getByRole('button', { name: chatName, exact: true })
      .waitFor({ state: 'visible' })
    await cleanComposer('group', '主人，这次让我们一起完成什么？')
    checks.push('group creation saves a separate group sidebar entry and a clean group composer')
    checks.push('new group creation defaults to sixteen total member task starts per round')
    const groupSettings = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]:visible')
    const batchPermissions = groupSettings.getByRole('group', { name: '统一设置成员权限', exact: true })
    const batchPicker = batchPermissions.getByRole('button', { name: /^所有成员权限/u })
    await batchPicker.waitFor({ state: 'visible' })
    assert.equal(await groupSettings.getByRole('switch', { name: '显示交接记录与状态', exact: true })
      .getAttribute('aria-checked'), 'true')
    for (const name of ['基本信息', '成员与分工', '协作规则', '工作资料', '统一设置成员权限']) {
      const weight = await groupSettings.getByRole('heading', { name, exact: true })
        .evaluate(element => Number(getComputedStyle(element).fontWeight))
      assert(weight >= 600, name + ' must read as a section heading')
    }
    assert(await groupSettings.getByRole('group', { name: '群内职责', exact: true }).locator('legend')
      .evaluate(element => Number(getComputedStyle(element).fontWeight)) >= 600)
    checks.push('group settings section headings are bold and handoff records are enabled by default')
    for (const name of names) {
      await groupSettings.getByRole('group', { name: name + '的群内权限', exact: true })
        .getByRole('button', { name: /工作区内修改/u }).waitFor({ state: 'visible' })
    }
    await batchPicker.click()
    await page.getByRole('menuitem', { name: '仅可查看', exact: true }).click()
    assert.equal(await page.getByRole('dialog').count(), 0, 'Read-only bulk selection needs no risk confirmation')
    for (const name of names) {
      await groupSettings.getByRole('group', { name: name + '的群内权限', exact: true })
        .getByRole('button', { name: /仅可查看/u }).waitFor({ state: 'visible' })
    }
    await page.waitForFunction(() => {
      const group = [...document.querySelectorAll('[role="group"]')]
        .find(element => element.getAttribute('aria-label') === '统一设置成员权限')
      return group !== undefined && [...group.querySelectorAll('[role="status"] li')]
        .filter(item => item.textContent.endsWith('已应用')).length === 2
    })
    checks.push('one safe bulk selection updates both exact group member permissions and reports two confirmed successes')
    await page.screenshot({ path: join(directory, '03-group-chat.png'), animations: 'disabled' })
    for (const name of names) {
      await page.getByRole('region', { name: '未分组', exact: true }).getByRole('button', { name, exact: true }).click()
      const privateSettings = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]:visible')
      await privateSettings.getByRole('heading', { name: '操作权限', exact: true }).waitFor({ state: 'visible' })
      await privateSettings.getByRole('button', { name: /工作区内修改/u }).waitFor({ state: 'visible' })
      assert.equal(await privateSettings.getByRole('button', { name: /仅可查看/u }).count(), 0)
    }
    checks.push('bulk group permissions leave both members’ private chat permissions unchanged')
    await page.getByRole('region', { name: '群聊', exact: true }).getByRole('button', { name: chatName, exact: true }).click()
    await cleanComposer('group-returned', '主人，这次让我们一起完成什么？')
    await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]:visible')
      .getByRole('group', { name: '统一设置成员权限', exact: true })
      .getByRole('button', { name: /^所有成员权限.*仅可查看/u }).waitFor({ state: 'visible' })
    const seedHandoffs = async phase => {
      const response = await page.request.post(origin + '/katcats-packaged-ui-handoff-' + phase)
      assert.equal(response.status(), 200)
      return response.json()
    }
    const waitForCards = async (tasks, handoffs) => {
      await page.waitForFunction(expected => document.querySelectorAll('[data-katcats-task]').length === expected.tasks
        && document.querySelectorAll('[data-katcats-handoff]').length === expected.handoffs, { tasks, handoffs })
    }
    const seeded = await seedHandoffs('first')
    await waitForCards(seeded.taskCount, seeded.handoffCount)
    await page.getByText(seeded.sentinel, { exact: true }).waitFor({ state: 'visible' })
    checks.push('persisted synthetic lifecycle events render two task cards and one full handoff beside ordinary chat')
    const handoffToggle = groupSettings.getByRole('switch', { name: '显示交接记录与状态', exact: true })
    const waitForAutomaticDisplaySave = async checked => {
      await page.waitForFunction(expected => {
        const toggle = document.querySelector('[role="switch"][aria-label="显示交接记录与状态"]')
        return toggle !== null && toggle.getAttribute('aria-checked') === String(expected) && !toggle.disabled
      }, checked)
      assert.equal(await groupSettings.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true)
    }
    await handoffToggle.click()
    await waitForAutomaticDisplaySave(false)
    await waitForCards(0, 0)
    await page.getByText(seeded.sentinel, { exact: true }).waitFor({ state: 'visible' })
    const seededWhileHidden = await seedHandoffs('second')
    await waitForCards(0, 0)
    await page.getByRole('region', { name: '未分组', exact: true }).getByRole('button', { name: names[0], exact: true }).click()
    await cleanComposer('private-after-display-change', '主人，有什么需要我帮忙的？')
    await page.getByRole('region', { name: '群聊', exact: true }).getByRole('button', { name: chatName, exact: true }).click()
    await handoffToggle.waitFor({ state: 'visible' })
    assert.equal(await handoffToggle.getAttribute('aria-checked'), 'false', 'Group display choice must survive settings navigation')
    await waitForCards(0, 0)
    await page.getByText(seeded.sentinel, { exact: true }).waitFor({ state: 'visible' })
    await handoffToggle.click()
    await waitForAutomaticDisplaySave(true)
    await waitForCards(seededWhileHidden.taskCount, seededWhileHidden.handoffCount)
    await page.getByText(seeded.sentinel, { exact: true }).waitFor({ state: 'visible' })
    checks.push('handoff toggle saves automatically, hides existing and subsequent records, stays off on navigation and restores all cards without hiding chat')
    await groupSettings.getByRole('heading', { name: '协作规则', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(directory, '04-group-display-settings.png'), animations: 'disabled' })
    const pauseResponse = await page.request.post(origin + '/katcats-packaged-ui-queue')
    assert.equal(pauseResponse.status(), 200)
    const pausedQueue = await pauseResponse.json()
    assert.equal(pausedQueue.status, 'paused')
    assert.equal(pausedQueue.pauseReason, 'owner')
    assert.equal(pausedQueue.runId, null)
    const groupEditor = page.getByRole('textbox', { name: '主人，这次让我们一起完成什么？', exact: true })
    const interrupt = page.getByRole('button', { name: '打断并调整', exact: true })
    await interrupt.waitFor({ state: 'visible' })
    assert.equal(await interrupt.isDisabled(), true, 'An empty composer cannot interrupt the group')
    await groupEditor.fill('合成验收普通追问保留后台任务')
    assert.equal(await interrupt.isEnabled(), true)
    await groupEditor.press('Enter')
    const receipt = page.locator('[data-katcats-message-receipt]')
    await receipt.getByText('已收到，已加入群消息队列。', { exact: true }).waitFor({ state: 'visible' })
    await receipt.getByText('当前群已暂停，点击“继续”后处理排队消息。', { exact: true }).waitFor({ state: 'visible' })
    const queueResponse = await page.request.get(origin + '/katcats-packaged-ui-queue')
    assert.equal(queueResponse.status(), 200)
    const retainedQueue = await queueResponse.json()
    assert.equal(retainedQueue.status, 'paused', 'Ordinary Enter must not silently steer and restart a paused group')
    assert.equal(retainedQueue.pauseReason, 'owner')
    assert.notEqual(retainedQueue.runId, null)
    assert.equal(retainedQueue.queuedMessages, 1)
    assert.equal(retainedQueue.rootTurns, 0)
    assert.equal(retainedQueue.modelCalls, 0)
    assert.equal((await groupEditor.innerText()).trim(), '')
    assert.equal(await interrupt.isDisabled(), true)
    checks.push('ordinary Enter persists one queued message without unpausing the group, confirms receipt and exposes the separate explicit interrupt action')
    await page.screenshot({ path: join(directory, '05-group-queued-message.png'), animations: 'disabled' })
    after = await probe()
    assert.equal(after.modelCalls, 0, 'UI boot and entity creation must make zero model calls')
    assert.equal(after.bots, 3)
    assert.equal(after.chats, 1)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(consoleErrors, [])
    const result = { passed: true, productMode: '1', developmentModePresent: false, before, after, checks, composers,
      pageErrors, consoleErrors, modelCalls: 0, pausedQueue, retainedQueue,
      limitations: ['Task cards use persisted synthetic Session events. Queue submission uses the real paused Host; model execution, explicit interruption and the installed Electron shell were not exercised by this browser smoke.'] }
    await writeFile(join(directory, 'ui-result.json'), JSON.stringify(result, null, 2) + '\n')
    return result
  } catch (error) {
    if (page !== undefined) {
      await writeFile(join(directory, 'failure.aria.txt'), redact(await page.locator('body').ariaSnapshot()))
        .catch(error => { captureErrors.push(redact(error.message)) })
      await page.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' })
        .catch(error => { captureErrors.push(redact(error.message)) })
    }
    await writeFile(join(directory, 'ui-result.json'), JSON.stringify({ passed: false, before, after, checks, composers,
      pageErrors, consoleErrors, captureErrors, error: redact(error.stack ?? error.message ?? error) }, null, 2) + '\n')
    throw error
  } finally {
    await browser.close()
  }
}
