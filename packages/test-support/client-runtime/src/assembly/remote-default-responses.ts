/**
 * Default responses for every Remote endpoint the web assembly calls while
 * booting and rendering with no sessions, no workspaces, and default settings.
 * The comment above each row names the plugin that calls it; endpoints boot
 * never touches stay absent so a new call fails loud. `$events` is built into
 * `RemoteMock`.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses
 */
import { ok, openStream, type RemoteTable } from '@deepseek-ai/dsh-remote-mock'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BotId, TeamFrame, TeamSnapshot } from '@deepseek-ai/dsh-client-katcats-team/types'
import type { ChatFrame, ChatSnapshot } from '@deepseek-ai/dsh-client-katcats-team/chats-types'
import type { UsageAccountingSnapshot } from '@deepseek-ai/dsh-usage-accounting/types'

const emptyTeam: TeamSnapshot = { revision: 0, mainBotId: brandString<BotId>('fixture-main'), groups: [], bots: [],
  modelCapabilities: { override: true, followGlobal: true } }
const emptyChats: ChatSnapshot = { revision: 0, chats: [], deliveries: [], relayLimit: 8, activities: [] }
const teamBaseline: TeamFrame = { type: 'snapshot', value: emptyTeam }
const chatBaseline: ChatFrame = { type: 'snapshot', value: emptyChats }
const emptyUsage: UsageAccountingSnapshot = { revision: 0, month: '2000-01', today: '2000-01-01', trackingSince: '2000-01-01',
  keyConfigured: false, days: [], total: { date: '2000-01', cacheHitInputTokens: 0, cacheMissInputTokens: 0, outputTokens: 0,
    totalTokens: 0, cacheHitInputCostNanoyuan: '0', cacheMissInputCostNanoyuan: '0', outputCostNanoyuan: '0', costNanoyuan: '0', unpricedTokens: 0 } }

/** Fixture owners whose real Client plugin mounts its own generated Remote namespaces. */
export const selfMountedRemoteNamespaces: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-client-katcats-team': ['katcatsTeam', 'katcatsChats', 'katcatsMemory'],
}

/** Default responses of the boot-time Remote endpoints; a spec loads it first and layers its own table on top. */
export const remoteDefaultResponses: RemoteTable = {
  unary: {
    // api-session-controller `sessions.handleConnected()` on `connection/reset`.
    'session/list': ok({ items: [] }),
    // ui-workspace startup with no entries; first-use initialization is ineligible.
    'workspace/initializeDefault': ok(undefined),
    // ui-settings `mirror.ensure()` at apply and again on `connection/reset`.
    'settings/describe': ok({ writable: true, hasDocument: false, namespaces: [] }),
    // ui-model-selection `ModelDirectoryResolver` constructor.
    'session/modelCatalog': ok({
      default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routableProviders: [],
      groups: [],
      failures: [],
    }),
    // ui-agent-preset hero chip and header label on first mount.
    'agentPresets/list': ok({ presets: [] }),
    // cordis-client-runner `ClientCordisInspectRegistry.sync` at apply and on `connection/reset`.
    'dynamicCordisRunner/syncInspectManifest': ok(null),
    // ui-cordis inventory at apply and on `connection/reset`.
    'dynamicCordisRunner/inventory': ok([]),
    // ui-settings-plugins web-search card `readCredential()` when the settings mirror first publishes.
    'credentials/describe': ok({}),
    // ui-permission-presets `PermissionCatalogDirectory` on its first read for a connection generation.
    'permissionPresets/catalog': ok({ options: [] }),
    // ui-settings-account refreshes details after a stored-grant snapshot.
    'account/getProfile': ok(null),
    'account/getBalance': ok(null),
    // ui-settings-account bonus notice read and acknowledgement at signing in.
    'account/getUnnotifiedBonuses': ok(null),
    'account/ackBonusNotified': ok(true),
    // ui-usage-accounting refreshes its zero-usage sidebar snapshot in product profiles.
    'usageAccounting/snapshot': ok(emptyUsage),
  },
  // Stream endpoints the roster opens later than boot; declared so a spec that forgets the script gets a stream miss.
  streams: [
    // api-session-controller `SessionEventStream.follow` when a Session opens.
    'session/follow',
  ],
  stream: {
    // Katcats directory controllers keep empty owner directories live until the assembly disposes.
    'katcatsTeam/follow': openStream([teamBaseline]),
    'katcatsChats/follow': openStream([chatBaseline]),
    // api-session-controller client `apply`: the control stream's opening baseline, then open.
    'session/control': openStream([{ type: 'baseline', value: { projections: {} } }]),
    // ui-settings-account shares the account snapshot across settings and the sidebar menu.
    'account/watch': openStream([{ status: 'signed-out', attempt: null, links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }]),
    // api-workspace-controller client `apply`: the follow stream's opening baseline, then open.
    'workspace/follow': openStream([{ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }]),
    // api-remote-access client `mountAccess`: the owner's access snapshot, then open.
    'remoteAccess/follow': openStream([{ type: 'baseline', owner: true }]),
  },
}
