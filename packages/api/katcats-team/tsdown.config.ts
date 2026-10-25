import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/chats.js', 'lib/types/memory.js'], { hostPhase: true })
