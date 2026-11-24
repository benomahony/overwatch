import { test, type TestBody } from 'claude-code/testing'
import { assert } from '../../hooks/assert'
import { start, tcrProject } from './tcr'

export type Project = ReturnType<typeof tcrProject>
export type Engine = Parameters<TestBody>[0]
export type On = Parameters<TestBody>[1]

/** The engine and the hook registration a test is given. */
export type Kit = { $: Engine; on: On }

/** How long a test that plays several turns may run, in real time, where the default limit leaves too little headroom. */
export const LONG_TEST_MS = 30_000

/** How long the test of a search whose reads never answer may run, which is longer than a long test, since the mock clock steps through its limits. */
export const SEARCH_TEST_MS = 60_000

/** A test with the limit of a test that plays several turns, which a loaded machine needs for a test of any length the default limit allows. */
export function longTest(name: string, body: TestBody) {
  assert(name !== '', `a test with the body ${typeof body} has no name`)
  test(name, { timeoutMs: LONG_TEST_MS }, body)
}

/** How long the checkpoint command takes to compare the files in the tests that set it, so that a person's write or another editing tool lands while it runs. */
export const FINGERPRINT_MS = 100

export const START_MS = 600
export const SETTLE_MS = 1300
export const END_MS = 500
export const DECIDE_MS = 100
export const JUDGE_MS = 450
export const WORSE = 'zanity: 0 errors and 31 warnings in 1 of 1 files\n'
export const OFFLINE = 'dns error: failed to lookup address information\nzanity: 1 error, 0 warnings in 1 of 1 files\n'

/** Runs body in a started session of a project that runs in TCR mode, and always ends the session. */
export async function inSession({ $, on }: Kit, body: (project: Project) => Promise<void>, options: Parameters<typeof tcrProject>[1] = {}) {
  const project = tcrProject(on, options)
  const { asked } = project.workspace
  assert(typeof $.session.start === 'function', 'the engine has no session to start')
  assert(asked.length === 0, `the project asked the checkpoint command before the session started: ${asked}`)
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
export async function edit($: Engine, project: Project, files: string[], fingerprint: string) {
  assert(files.length > 0 && fingerprint !== '', `an edit changes files and leaves a fingerprint; got ${files} and ${JSON.stringify(fingerprint)}`)
  project.willChange(files, fingerprint)
  await $.tool.call({ tool: 'Edit', file_path: `/repo/${files[0]}` })
  await project.clock.advance(SETTLE_MS)
  assert(project.workspace.next === undefined, `the edit of ${files} never reached the project; the tool call must apply it`)
}

/** An editing tool call that has begun and writes `change` only once `end` is called, so that the files can change around it while it runs; `done` settles when the plugin has looked at the result. */
function begin($: Engine, project: Project, change: { files: string[]; fingerprint: string }, tool: 'Edit' | 'Bash'): { end: () => void; done: Promise<unknown> } {
  assert(change.files.length > 0 && change.fingerprint !== '', `an edit changes files and leaves a fingerprint; got ${change.files} and ${JSON.stringify(change.fingerprint)}`)
  const filePath = `/repo/${change.files[0]}`
  let end = () => undefined
  const gate = new Promise<void>(resolve => { end = resolve })
  project.workspace.calls.set(filePath, { change, gate })
  const done = tool === 'Bash' ? $.tool.call({ tool, command: 'make', file_path: filePath }) : $.tool.call({ tool, file_path: filePath })
  assert(project.workspace.calls.has(filePath), `the call of ${filePath} is not waiting to end`)
  return { end, done }
}

/** An editing tool call that has begun and writes `files` only once `end` is called, so that the files can change around it while it runs; `done` settles when the plugin has looked at the result. */
export function beginEdit($: Engine, project: Project, files: string[], fingerprint: string): { end: () => void; done: Promise<unknown> } {
  assert(files.length > 0 && fingerprint !== '', `an edit changes files and leaves a fingerprint; got ${files} and ${JSON.stringify(fingerprint)}`)
  return begin($, project, { files, fingerprint }, 'Edit')
}

/** A shell command that has begun and writes `files` only once `end` is called, as `beginEdit` does for an edit. */
export function beginShell($: Engine, project: Project, files: string[], fingerprint: string): { end: () => void; done: Promise<unknown> } {
  assert(files.length > 0 && fingerprint !== '', `a shell command changes files and leaves a fingerprint; got ${files} and ${JSON.stringify(fingerprint)}`)
  return begin($, project, { files, fingerprint }, 'Bash')
}

/** Makes `change` happen as the `nth` ask of `command` from now begins, before the checkpoint command answers it. */
export function during(project: Project, command: string, nth: number, change: () => void) {
  const { hooks, asked } = project.workspace
  const before = asked.filter(each => each === command).length
  assert(nth > 0, `the ask ${nth} of ${command} is no ask to count from now`)
  hooks[`${command}#${before + nth}`] = change
  assert(hooks[`${command}#${before + nth}`] === change, `the change for the ask ${before + nth} of ${command} was not set`)
}

/** A person's file lands in the repository, leaving the files with a fingerprint no edit of the agent left. */
export function personWrites(project: Project, fingerprint = 'person') {
  const { workspace } = project
  assert(!workspace.dirty.includes('person.py'), 'the person wrote the same file twice, which changes nothing')
  workspace.dirty = [...workspace.dirty, 'person.py']
  workspace.fingerprint = fingerprint
  assert(workspace.dirty.includes('person.py') && workspace.fingerprint === fingerprint, `the person's file did not land in the project: ${workspace.dirty} at ${workspace.fingerprint}`)
}

/** What the agent was told, in the prompts it was woken with and the messages added to its turn. */
export function told(project: Project): string[] {
  const texts = project.prompts.concat(project.appended())
  assert(texts.every(text => typeof text === 'string'), `what the agent was told holds ${texts.filter(text => typeof text !== 'string')}, which is no text`)
  assert(texts.length >= project.prompts.length, `${texts.length} messages told but ${project.prompts.length} prompts alone`)
  return texts
}


/** What the agent was told, as the text it reads: the messages added to its turn are written as the host stores them, with their characters escaped, and read back here. */
export function toldPlain(project: Project): string[] {
  const texts = told(project).map(text => (text.startsWith('[{') ? (JSON.parse(text) as { text: string }[]).map(part => part.text).join('') : text))
  assert(texts.every(text => !text.startsWith('[{')), `what the agent was told still holds stored messages: ${texts.filter(text => text.startsWith('[{'))}`)
  return texts
}

/** How far the project's clock moves at a time while a test waits for work to settle, and how far it moves before the test gives up. */
export const STEP_MS = 20
export const GIVE_UP_MS = 5000

/** How long, in milliseconds of the project's clock, `work` took to settle. */
export async function takes(project: Project, work: Promise<unknown>): Promise<number> {
  assert(STEP_MS > 0 && GIVE_UP_MS > STEP_MS, `a wait that moves ${STEP_MS}ms at a time and gives up after ${GIVE_UP_MS}ms never settles`)
  let isSettled = false
  void work.then(() => { isSettled = true }, () => { isSettled = true })
  let elapsed = 0
  while (!isSettled && elapsed < GIVE_UP_MS) {
    await project.clock.advance(STEP_MS)
    elapsed += STEP_MS
  }
  return elapsed
}
