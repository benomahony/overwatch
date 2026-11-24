import { expect } from 'claude-code/testing'
import { sweepEntries, type Entry } from './fixtures/tcr-net-entries'
import type { Run } from './fixtures/tcr-net'
import { CLEAN } from './fixtures/tcr'
import { edit } from './fixtures/tcr-session'

/** A tool call that already ran returns its result whatever breaks after it, so no step of the host that throws rejects it. */
const resolves = (run: Run) => expect({ steps: run.steps, rejections: run.awaited.length }).toEqual({ steps: run.steps, rejections: 0 })

const ENTRIES: Entry[] = [
  {
    name: 'an editing tool call whose edit the checks keep',
    steps: 31,
    prepare: project => project.setReport(CLEAN),
    entry: ($, project) => edit($, project, ['a.py'], 'f1'),
    holds: resolves,
  },
  {
    name: 'an editing tool call whose edit a check fails, which TCR reverts',
    steps: 30,
    entry: ($, project) => edit($, project, ['a.py'], 'f1'),
    holds: resolves,
  },
]

sweepEntries(ENTRIES)
