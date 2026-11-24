import { expect } from 'claude-code/testing'
import { sweepEntries, type Entry } from './fixtures/tcr-net-entries'
import { SETTLE_MS } from './fixtures/tcr-session'

const GUARDED_EDIT = { mode: 'tcr', gate: { protected_actions: [{ tool: 'Edit' }] } }
const GUARDED_ONLY = { gate: { protected_actions: [{ tool: 'Edit' }] } }
const EDITED_FILE = 'a.py'
const UNEXPECTED = 'overwatch hit an unexpected error'

const ENTRIES: Entry[] = [
  {
    name: 'an editing tool call that a failing check guards',
    steps: 2,
    options: { settings: GUARDED_ONLY },
    entry: async ($, project) => {
      await project.clock.advance(SETTLE_MS)
      project.willChange(['a.py'], 'f1')
      return $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    },
    holds: (run, isPropagated) => {
      expect({ steps: run.steps, rejections: run.awaited.length }).toEqual({ steps: run.steps, rejections: 0 })
      if (!isPropagated) return
      expect(run.project.workspace.dirty).toEqual([EDITED_FILE])
      expect(run.told.filter(text => text.includes(UNEXPECTED)).length).toBe(1)
    },
  },
  {
    name: 'an editing tool call that a failing check guards while TCR runs',
    steps: 2,
    options: { settings: GUARDED_EDIT },
    entry: async ($, project) => {
      await project.clock.advance(SETTLE_MS)
      project.willChange(['a.py'], 'f1')
      return $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    },
    holds: run => expect({ steps: run.steps, rejections: run.awaited.length }).toEqual({ steps: run.steps, rejections: 0 }),
  },
]

sweepEntries(ENTRIES)
