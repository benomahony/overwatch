import { expect } from 'claude-code/testing'
import { CLEAN, WARNINGS, start, tcrProject } from './fixtures/tcr'
import { START_MS, longTest, type Engine, type Project } from './fixtures/tcr-session'

const GUARDED_ONLY = { gate: { protected_actions: [{ tool: 'Edit' }] } }
const REPORTED_MS = 710
const SESSIONS = 3
const ENDING_MS = 600
const WITH_PRINT_WAITING_MS = 40
const WITH_NO_PRINT_WAITING_MS = 450

async function playSession($: Engine, project: Project, endsAfterMs: number) {
  project.setReport(CLEAN)
  await $.session.start(start)
  await project.clock.advance(START_MS)
  project.setReport(WARNINGS)
  await project.clock.advance(REPORTED_MS)
  project.willChange(['a.py'], 'f1')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' }).catch(() => undefined)
  await project.clock.advance(endsAfterMs)
  const landed = project.workspace.dirty.length > 0
  project.workspace.dirty = []
  project.workspace.next = undefined
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(ENDING_MS)
  await ending
  return landed
}

const ENDINGS = [
  { name: 'a print of the watcher still waits out its quiet period when the session ends', endsAfterMs: WITH_PRINT_WAITING_MS },
  { name: 'no print of the watcher waits when the session ends', endsAfterMs: WITH_NO_PRINT_WAITING_MS },
]

for (const { name, endsAfterMs } of ENDINGS) {
  longTest(`a gate that denied an edit in the first session denies it in each session after it, when ${name}`,  async ($, on) => {
    const project = tcrProject(on, { settings: GUARDED_ONLY })
    const landed: boolean[] = []
    for (let session = 0; session < SESSIONS; session += 1) landed.push(await playSession($, project, endsAfterMs))
    expect(landed).toEqual([false, false, false])
  })
}
