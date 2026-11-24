import { expect } from 'claude-code/testing'
import { send } from '../hooks/delivery'
import { queueRevertNotice } from '../hooks/pausing'
import { revertNotice } from '../hooks/revert-slots'
import { stopWaiting, whenQuiet } from '../hooks/quiet'
import { initialState, liveWatcher, type LiveWatcher, type State } from '../hooks/state'
import { queueRevert } from '../hooks/revert-aftermath'
import { CHECKERS, readReport, type Report, type Watcher } from '../hooks/watchers'
import { longTest } from './fixtures/tcr-session'

const MAX_REVERT_NOTICES = 5
const REVERT_NOTICE = { text: 'overwatch: TCR reverted the latest change', isWaking: true, kind: 'tcr' as const }

longTest('a notice the host refuses after its session ended does not wait in the next session', async () => {
  const state = initialState()
  state.isTurnRunning = true
  state.outbox.set('tcr:revert', REVERT_NOTICE)
  let refuse: () => void = () => undefined
  const refused = new Promise<void>(resolve => { refuse = resolve })
  const $ = { session: { append: async () => { await refused; throw new Error('the host refused') } }, ui: { log: () => undefined } } as never
  const sending = send($, state).catch(() => undefined)
  state.epoch += 1
  state.outbox.clear()
  refuse()
  await sending
  expect(state.outbox.size).toBe(0)
})

const OVER_THE_CAP = 2

function takingHost() {
  const taken: string[] = []
  const $ = {
    session: { append: async ({ message }: { message: { content: { text: string }[] } }) => { taken.push(message.content[0]?.text ?? '') } },
    clock: { after: () => ({ cancel: () => undefined }), sleep: async () => undefined },
    ui: { log: () => undefined },
  } as never
  return { $, taken }
}

const revertOf = (ref: string) => revertNotice(`overwatch: TCR reverted the latest change. The discarded work is saved in \`${ref}\`.`, true)

longTest('two reverts the agent was not told of between them are both told', async () => {
  const state = initialState()
  state.isTurnRunning = true
  const host = takingHost()
  queueRevertNotice(host.$, state, revertOf('refs/overwatch/reverted/1'))
  queueRevertNotice(host.$, state, revertOf('refs/overwatch/reverted/2'))
  await send(host.$, state)
  expect(host.taken.join('')).toContain('refs/overwatch/reverted/1')
  expect(host.taken.join('')).toContain('refs/overwatch/reverted/2')
})

longTest('reverts past the cap are told as a count, and no revert is lost', async () => {
  const state = initialState()
  state.isTurnRunning = true
  const host = takingHost()
  for (let revert = 1; revert <= MAX_REVERT_NOTICES + OVER_THE_CAP; revert += 1) queueRevertNotice(host.$, state, revertOf(`refs/overwatch/reverted/${revert}`))
  await send(host.$, state)
  const text = host.taken.join('')
  expect(text.match(/reverted the latest change/g)?.length).toBe(MAX_REVERT_NOTICES)
  expect(text).toContain(`${OVER_THE_CAP} more reverts or attempts`)
})

const RUN_OF_SESSION = (session: number, state: State, live: LiveWatcher) => ({ state, live, watcher: {} as Watcher, cwd: '/repo', epoch: session })

function timersOf() {
  const started: { run: () => void; isCancelled: boolean }[] = []
  const $ = {
    clock: { after: (_ms: number, run: () => void) => { const timer = { run, isCancelled: false }; started.push(timer); return { cancel: () => { timer.isCancelled = true } } } },
    ui: { log: () => undefined },
  } as never
  return { $, started }
}

longTest('a run that ends after the next session began cancels its own wait and not the next run\'s', async () => {
  const state = initialState()
  state.epoch = 1
  const live = liveWatcher('zanity:/repo', '/repo')
  const host = timersOf()
  whenQuiet(host.$, RUN_OF_SESSION(1, state, live), () => undefined)
  stopWaiting(RUN_OF_SESSION(0, state, live))
  expect(host.started.map(timer => timer.isCancelled)).toEqual([false])
})

longTest('a run of a session that ended waits for nothing, so its late output arms no timer', async () => {
  const state = initialState()
  state.epoch = 1
  const live = liveWatcher('zanity:/repo', '/repo')
  const host = timersOf()
  whenQuiet(host.$, RUN_OF_SESSION(0, state, live), () => undefined)
  expect(host.started.length).toBe(0)
})

longTest('a notice the host refused keeps its place when a newer revert took its key meanwhile', async () => {
  const state = initialState()
  const { $ } = takingHost()
  let refuse: () => void = () => undefined
  const refused = new Promise<void>(resolve => { refuse = resolve })
  const submitting = { ...($ as object), prompt: { submit: async () => { await refused; throw new Error('the host refused') } } } as never
  queueRevertNotice($, state, revertOf('refs/overwatch/reverted/first'))
  const sending = send(submitting, state).catch(() => undefined)
  queueRevertNotice($, state, revertOf('refs/overwatch/reverted/second'))
  refuse()
  await sending
  const waiting = [...state.outbox.values()].map(({ text }) => text).join('')
  expect(waiting).toContain('refs/overwatch/reverted/first')
  expect(waiting).toContain('refs/overwatch/reverted/second')
})

longTest('a count the host refused is added to the count that took its key meanwhile', async () => {
  const state = initialState()
  const { $ } = takingHost()
  let refuse: () => void = () => undefined
  const refused = new Promise<void>(resolve => { refuse = resolve })
  const submitting = { ...($ as object), prompt: { submit: async () => { await refused; throw new Error('the host refused') } } } as never
  for (let revert = 0; revert <= MAX_REVERT_NOTICES; revert += 1) queueRevertNotice($, state, revertOf(`refs/overwatch/reverted/${revert}`))
  const sending = send(submitting, state).catch(() => undefined)
  for (let revert = 0; revert <= MAX_REVERT_NOTICES; revert += 1) queueRevertNotice($, state, revertOf(`refs/overwatch/reverted/more${revert}`))
  refuse()
  await sending
  const kept = [...state.outbox.values()].reduce((sum, { reverts }) => sum + (reverts?.total ?? 0), 0)
  expect(kept).toBe(2 * (MAX_REVERT_NOTICES + 1))
})

longTest('the count of reverts past the cap names copies only when a revert saved one', async () => {
  const state = initialState()
  const { $ } = takingHost()
  for (let revert = 0; revert < MAX_REVERT_NOTICES + OVER_THE_CAP; revert += 1) queueRevertNotice($, state, revertNotice('overwatch: TCR tried to revert the latest change.', revert === MAX_REVERT_NOTICES))
  const counted = [...state.outbox.values()].filter(({ reverts }) => reverts !== undefined && reverts.total > 1).map(({ text }) => text).join('')
  expect(counted).toContain('1 of them saved a copy')
  const unsaved = initialState()
  for (let revert = 0; revert < MAX_REVERT_NOTICES + OVER_THE_CAP; revert += 1) queueRevertNotice($, unsaved, revertNotice('overwatch: TCR tried to revert the latest change.', false))
  const none = [...unsaved.outbox.values()].map(({ text }) => text).join('')
  expect(none).toContain('None of them saved a copy')
  expect(none).not.toContain('lists the copies')
})

const WARNINGS_OUTPUT = 'zanity: 0 errors and 29 warnings in 1 of 1 files\n'
const LOG_PATH = '/home/me/.cache/overwatch/logs/zanity-repo.log'

function failingLive() {
  const zanity = CHECKERS.find(({ name }) => name === 'zanity') as Watcher
  const live = liveWatcher('zanity:/repo', '/repo')
  live.watcher = zanity
  return { live, report: readReport(zanity, WARNINGS_OUTPUT) as Report }
}

longTest('the notice of a revert waits in the outbox while the write of the log of its check has not answered, and names the log once it has (queueRevert)', async () => {
  const state = initialState()
  const { live, report } = failingLive()
  let answer: () => void = () => undefined
  const held = new Promise<void>(resolve => { answer = resolve })
  const $ = {
    clock: { after: () => ({ cancel: () => undefined }) },
    env: { get: async () => { await held; return '/home/me' } },
    fs: { write: async () => undefined },
    ui: { log: () => undefined },
  } as never
  const logging = queueRevert($, state, { causes: [{ live, report }], build: told => `overwatch: TCR reverted the latest change.${told[0]?.log === undefined ? '' : ` Output: ${told[0].log}`}`, isSaved: true })
  const before = [...state.outbox.values()].map(({ text }) => text)
  answer()
  await logging
  const after = [...state.outbox.values()].map(({ text }) => text)
  expect({ waitingBefore: before.length, namedBefore: before.some(text => text.includes(LOG_PATH)), namedAfter: after.some(text => text.includes(LOG_PATH)), waitingAfter: after.length }).toEqual({ waitingBefore: 1, namedBefore: false, namedAfter: true, waitingAfter: 1 })
})

function heldLogHost() {
  let answer: () => void = () => undefined
  const held = new Promise<void>(resolve => { answer = resolve })
  const $ = {
    clock: { after: () => ({ cancel: () => undefined }) },
    env: { get: async () => { await held; return '/home/me' } },
    fs: { write: async () => undefined },
    ui: { log: () => undefined },
  } as never
  return { $, answer }
}

const buildNamingLog = (told: { log?: string }[]) => `overwatch: TCR reverted the latest change.${told[0]?.log === undefined ? '' : ` Output: ${told[0].log}`}`

longTest('a notice of a revert that went out before the log was written does not name the log: nothing is queued again (queueRevert)', async () => {
  const state = initialState()
  const { live, report } = failingLive()
  const host = heldLogHost()
  const logging = queueRevert(host.$, state, { causes: [{ live, report }], build: buildNamingLog, isSaved: true })
  state.outbox.clear()
  host.answer()
  await logging
  expect(state.outbox.size).toBe(0)
})

longTest('a notice of a revert that another notice replaced before the log was written stays replaced (queueRevert)', async () => {
  const state = initialState()
  const { live, report } = failingLive()
  const host = heldLogHost()
  const logging = queueRevert(host.$, state, { causes: [{ live, report }], build: buildNamingLog, isSaved: true })
  const [key] = [...state.outbox.keys()]
  const replacement = { ...REVERT_NOTICE, text: 'overwatch: another notice' }
  state.outbox.set(key as string, replacement)
  host.answer()
  await logging
  expect([...state.outbox.values()]).toEqual([replacement])
})
