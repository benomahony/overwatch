import { assert } from '../../hooks/assert'
import { start, tcrProject } from './tcr'

export type Project = ReturnType<typeof tcrProject>
export type Engine = Parameters<Parameters<typeof test>[1]>[0]
export type On = Parameters<Parameters<typeof test>[1]>[1]

/** The engine and the hook registration a test is given. */
export type Kit = { $: Engine; on: On }

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

/** Makes `change` happen as the `nth` ask of `command` from now begins, before the checkpoint command answers it. */
export function during(project: Project, command: string, nth: number, change: () => void) {
  const { hooks, asked } = project.workspace
  const before = asked.filter(each => each === command).length
  assert(nth > 0, `the ask ${nth} of ${command} is no ask to count from now`)
  hooks[`${command}#${before + nth}`] = change
  assert(hooks[`${command}#${before + nth}`] === change, `the change for the ask ${before + nth} of ${command} was not set`)
}

/** A person's file lands in the repository, leaving the files with a fingerprint no edit of the agent left. */
export function personWrites(project: Project) {
  const { workspace } = project
  assert(!workspace.dirty.includes('person.py'), 'the person wrote the same file twice, which changes nothing')
  workspace.dirty = [...workspace.dirty, 'person.py']
  workspace.fingerprint = 'person'
  assert(workspace.dirty.includes('person.py') && workspace.fingerprint === 'person', `the person's file did not land in the project: ${workspace.dirty} at ${workspace.fingerprint}`)
}

/** What the agent was told, in the prompts it was woken with and the messages added to its turn. */
export function told(project: Project): string[] {
  const texts = project.prompts.concat(project.appended())
  assert(texts.every(text => typeof text === 'string'), `what the agent was told holds ${texts.filter(text => typeof text !== 'string')}, which is no text`)
  assert(texts.length >= project.prompts.length, `${texts.length} messages told but ${project.prompts.length} prompts alone`)
  return texts
}

