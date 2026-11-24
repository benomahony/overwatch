import { sweepEntries, type Entry } from './fixtures/tcr-net-entries'
import { edit, SETTLE_MS } from './fixtures/tcr-session'

const PERSON_FILE = 'person.py'

const ENTRIES: Entry[] = [
  {
    name: 'the start of a turn',
    steps: 32,
    entry: ($, project) => $.turn.start({ text: 'again', turnId: 't2' }).then(() => project.clock.advance(SETTLE_MS)),
  },
  {
    name: 'an editing tool call after a person wrote a file',
    steps: 10,
    entry: ($, project) => { project.workspace.dirty = [PERSON_FILE]; project.workspace.fingerprint = 'person'; return edit($, project, ['a.py'], 'f1') },
  },
]

sweepEntries(ENTRIES)
