import { sweepEntries, type Entry } from './fixtures/tcr-net-entries'
import { ended } from './fixtures/tcr'
import { SETTLE_MS } from './fixtures/tcr-session'

const STOP_PARTS = 3
const GUARDED_ONLY = { gate: { protected_actions: [{ tool: 'Edit' }] } }

const ENTRIES: Entry[] = [
  {
    name: 'the end of a turn over a failing check',
    steps: 27,
    options: { settings: GUARDED_ONLY },
    parts: STOP_PARTS,
    entry: async ($, project) => {
      await project.clock.advance(SETTLE_MS)
      const answer = await $.turn.complete(ended)
      await $.turn.start({ text: 'again', turnId: 't2' })
      await project.clock.advance(SETTLE_MS)
      return answer
    },
  },
]

sweepEntries(ENTRIES)
