import { expect, test } from 'claude-code/testing'
import { assert } from '../hooks/assert'
import { CLEAN, WARNINGS, ZIG_RED, start, tcrProject } from './fixtures/tcr'

type Project = ReturnType<typeof tcrProject>
type Engine = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

/** The engine and the hook registration a test is given. */
type Kit = { $: Engine; on: On }

const START_MS = 600
const SETTLE_MS = 1300
const END_MS = 500
const DECIDE_MS = 100
const JUDGE_MS = 450
const OFFLINE = 'dns error: failed to lookup address information\nzanity: 1 error, 0 warnings in 1 of 1 files\n'

/** Runs body in a started session of a project that runs in TCR mode, and always ends the session. */
async function inSession({ $, on }: Kit, body: (project: Project) => Promise<void>, options: Parameters<typeof tcrProject>[1] = {}) {
  const project = tcrProject(on, options)
  assert(typeof $.session.start === 'function', 'the engine has no session to start')
  assert(project.workspace.asked.length === 0, `the project asked the checkpoint command before the session started: ${project.workspace.asked}`)
  try {
    await $.session.start(start)
    await project.clock.advance(START_MS)
    await body(project)
  } finally {
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(END_MS)
    await ending
  }
}

/** The agent edits the files, and the project's checks judge the edit. */
async function edit($: Engine, project: Project, files: string[], fingerprint: string) {
  assert(files.length > 0 && fingerprint !== '', `an edit changes files and leaves a fingerprint; got ${files} and ${JSON.stringify(fingerprint)}`)
  project.willChange(files, fingerprint)
  await $.tool.call({ tool: 'Edit', file_path: `/repo/${files[0]}` })
  await project.clock.advance(SETTLE_MS)
  assert(project.workspace.next === undefined, `the edit of ${files} never reached the project; the tool call must apply it`)
}

/** What the agent was told, in the prompts it was woken with and the messages added to its turn. */
function told(project: Project): string[] {
  const texts = project.prompts.concat(project.appended())
  assert(texts.every(text => typeof text === 'string'), `what the agent was told holds ${texts.filter(text => typeof text !== 'string')}, which is no text`)
  assert(texts.length >= project.prompts.length, `${texts.length} messages told but ${project.prompts.length} prompts alone`)
  return texts
}

test('an edit that keeps the checks green is committed as a checkpoint', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.reverted).toEqual([])
  })
})

test('an edit that adds a failure is reverted and the agent is told which failure and which files', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py', 'extra.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([['example.py', 'extra.py']])
    const reverted = project.prompts.filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('29 warnings')
    expect(reverted[0]).toContain('`example.py`')
    expect(reverted[0]).toContain('`extra.py`')
    expect(project.prompts.filter(text => text.includes('failed after the latest change'))).toEqual([])
  })
})

test('a watcher that stays silent for an edit does not hold the edit: its own run judges it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['README.md'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: README.md'])
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['example.py']])
  }, { silentWatcher: true })
})

test('a failure the session started with is left alone', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.reverted).toEqual([])
  }, { initial: WARNINGS })
})

test('a failure that returns after a revert is reverted and told again', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    await $.turn.start({ text: project.prompts[0] ?? '', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f2')
    expect(project.workspace.reverted.length).toBe(2)
    expect(told(project).filter(text => text.includes('TCR reverted')).length).toBe(2)
  })
})

test('a tool that changes no file is never judged, a checkpoint or a revert, whatever its name', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.asked).not.toContain('checkpoint')
    expect(project.workspace.asked).not.toContain('revert')
  })
})

test('a tool that changes no file while an edit waits does not judge it again', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(300)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await project.clock.advance(300)
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(project.workspace.oneShots).toEqual(['zanity'])
  })
})

test('two edits made before the first is judged are judged once, together', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(100)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
    expect(project.workspace.oneShots).toEqual(['zanity'])
  })
})

test('an edit made while the first is being judged cancels that judgement', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(JUDGE_MS + 100)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS + 400)
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
  }, { judgeDelayMs: 300 })
})

test('each new edit makes the judgement wait again until the files are quiet', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(300)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(300)
    expect(project.workspace.oneShots).toEqual([])
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
  })
})

test('a judgement started before a newer edit is never read as that edit\'s', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(550)
    project.setReport(WARNINGS)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(1900)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([['a.py', 'b.py']])
  }, { judgeDelayMs: 300 })
})

test('files that change while the checks judge the edit are acted on by nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    project.willChange(['example.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py' })
    await project.clock.advance(JUDGE_MS + 100)
    project.workspace.fingerprint = 'someone-else'
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { judgeDelayMs: 500 })
})

test('TCR does not start on a dirty tree and nothing is reverted', async ($, on) => {
  const project = tcrProject(on)
  project.workspace.dirty = ['mine.py']
  project.workspace.fingerprint = 'mine'
  try {
    await $.session.start(start)
    await project.clock.advance(START_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable'))).toBe(true)
  } finally {
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(END_MS)
    await ending
  }
})

test('files that change at a tool that does not edit pause TCR until the next turn start', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['mine.py'], 'mine')
    await $.tool.call({ tool: 'Read', file_path: '/repo/mine.py' })
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.commits).toEqual([])
    project.workspace.dirty = []
    project.workspace.committed = project.workspace.fingerprint
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['again.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['again.py']])
  })
})

test('a person\'s change seen at a tool that does not edit, while an edit waits, is never committed or reverted as the agent\'s', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['agent1.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/agent1.py' })
    project.willChange(['person.py'], 'p1')
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    project.willChange(['agent2.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/agent2.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.dirty).toEqual(['agent1.py', 'person.py', 'agent2.py'])
  })
})

test('a failed checkpoint commit pauses TCR and reverts nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.refusal = 'the checkpoint commit failed and its changes are left staged: refused'
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('left staged'))).toBe(true)
    project.setReport(WARNINGS)
    await edit($, project, ['again.py'], 'f2')
    expect(project.workspace.reverted).toEqual([])
  })
})

test('a check that cannot run here neither commits nor reverts, and the agent is told', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(OFFLINE)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).some(text => text.includes('these checks cannot run in this environment'))).toBe(true)
    expect(told(project).some(text => text.includes('TCR left the latest change uncommitted'))).toBe(true)
  })
})

test('the upstream check is not judged and never causes a revert', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.oneShots).toEqual(['zanity'])
  }, { withUpstream: true })
})

test('with inherited findings set to block, an edit that leaves one failing is neither committed nor reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { initial: WARNINGS, settings: { mode: 'tcr', gate: { inherited: 'block' } } })
})

test('without the mode nothing is judged, committed, reverted or asked of git', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.asked).toEqual([])
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.commits).toEqual([])
  }, { settings: {} })
})

test('an unknown mode is told to the user and nothing is committed or reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.toasts.some(text => text.includes('mode') && text.includes('tcr'))).toBe(true)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { settings: { mode: 'fast' } })
})

test('a new failure in any one check reverts the edit', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setZigReport(ZIG_RED)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['b.py']])
    expect(project.workspace.commits).toEqual([])
  }, { withZig: true })
})

test('an edit is committed only when every check judges it green', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(project.workspace.oneShots.sort()).toEqual(['zanity', 'zig'])
  }, { withZig: true })
})

test('an edit made as the decision is still being made is settled once it is', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(1)
    project.willChange(['a.py'], 'f1')
    const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    await call
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  }, { reasonDelayMs: 100 })
})

test('a failure with nothing to restore is told as a failure and reverts nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange([], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS + END_MS)
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).filter(text => text.includes('TCR reverted'))).toEqual([])
    expect(told(project).some(text => text.includes('29 warnings'))).toBe(true)
  })
})

test('a revert is told to the agent in the running turn even after another message in that turn', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    project.workspace.refusal = 'the checkpoint commit failed and its changes are left staged: refused'
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.appended().filter(text => text.includes('TCR is unavailable')).length).toBe(1)
    project.workspace.refusal = undefined
    project.workspace.dirty = []
    project.workspace.committed = project.workspace.fingerprint
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(DECIDE_MS)
    project.setReport('zanity: 0 errors and 3 warnings in 1 of 1 files\n')
    await edit($, project, ['example.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['example.py']])
    expect(project.appended().filter(text => text.includes('TCR reverted')).length).toBe(1)
  })
})

test('a check with a baseline command is run to its end and judged by its exit code', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.rs'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.rs'])
    project.setRustCode(1)
    await edit($, project, ['b.rs'], 'f2')
    expect(project.workspace.reverted).toEqual([['b.rs']])
    expect(told(project).some(text => text.includes('TCR reverted') && text.includes('cargo test'))).toBe(true)
  }, { withRust: true, withoutChecks: true })
})

test('an edit undone before it is judged is not judged', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(100)
    project.workspace.dirty = []
    project.workspace.fingerprint = 'clean'
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.commits).toEqual([])
  })
})

test('a failure with no earlier result of its check to compare with is held and told, not reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('no earlier result'))).toBe(true)
  }, { mute: true })
})

test('a green edit is committed even when its check has no earlier result', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  }, { mute: true })
})

test('a message of overwatch that is not about TCR still reaches the agent in a turn that TCR already told', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(1500)
    expect(project.appended().some(text => text.includes('TCR is on'))).toBe(true)
    await project.clock.advance(1500)
    expect(project.appended().some(text => text.includes('exited, so build failures are not reported'))).toBe(true)
  }, { watcherEndsAfterTicks: 4 })
})

test('a project without checks commits nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(CLEAN)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
  }, { withoutChecks: true })
})
