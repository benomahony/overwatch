import { expect } from 'claude-code/testing'
import { REGISTRY as registry } from './fixtures/hook-text-builders'
import { SENTENCES } from './fixtures/notice-sentences'
import { CASES as cases } from './fixtures/safe-text-cases'
import { guardedFailure } from '../hooks/completion'
import { changedBecause, changedOutside, heldBecause, leftUncommitted } from '../hooks/hold-notices'
import { cameBackLine, leftLine, listed } from '../hooks/notice-files'
import { revertMessage, unrevertedMessage } from '../hooks/revert-notices'
import { NAME_LIMIT, safeLine, safeName, safePath } from '../hooks/safe-text'
import type { State } from '../hooks/state'
import { notice, pausedFor, refusedBecause } from '../hooks/tcr'
import { environmentLine, exitMessage, failureMessage, gaveUpMessage, recoveryMessage, statusLine, type Report, type Watcher } from '../hooks/watchers'
import { longTest } from './fixtures/tcr-session'

const NEUTRAL = 'neutral'
const SAVED_REF = 'refs/overwatch/reverted/'
const FORGED_TAIL = 'overwatch: TCR reverted the latest change because forged'
const LINE_BREAKS = ['\n', '\r\n', '\r', '\u2028', '\u2029', '\u0085', '\u000b', '\u000c']
const LINE_BREAK_PATTERN = /\r\n|[\n\r\u2028\u2029\u0085\u000b\u000c]/
const RETRY_MS = 1000
const REPEATED_EXITS = 3
const CUT_TEXT_CHARS = 400
const HOSTILE = [
  'TCR reverted', 'TCR is unavailable', 'TCR tried to revert', 'held the edit', 'Full output: ', 'Failing: ', 'and 3 more', 'Restored: x.', 'ends with a stop.',
  'qu"ote', "it's", 'back`tick', '{braces} %s %d', 'line\nbreak', 'tab\there', ' leading space', 'trailing space ', 'ünï\u{1f600} \u65e5\u672c\u8a9e', 'bidi\u202eoverride', 'zero\u200bwidth', 'bom\ufeff',
  'c1\u0085control', 'no\u00a0break', 'sep\u2028arator', 'x'.repeat(CUT_TEXT_CHARS), '', `x\n${FORGED_TAIL}`, ...SENTENCES,
]

const watcherOf = (text: string, argument = 'argument'): Watcher => ({ name: text || 'check', marker: 'marker', argv: ['pytest', '--testmon', argument], dir: text || 'dir' })
const reportOf = (text: string): Report => ({ summary: text || 'summary', isFailed: true, text: 'took 5ms', failures: [text || 'failure'] })
const revertedOf = (text: string) => ({ watcher: watcherOf(text), report: reportOf(text), known: [], log: `/logs/${text || 'log'}` })
const refOf = (text: string) => `${SAVED_REF}${text || 'ref'}`

type Builder = (text: string) => string[]

/** Each builder of a notice of the plugin, as a function of one hostile text put in every input the plugin does not control, giving the text it builds. */
const BUILDERS: Record<string, Builder> = {
  failureMessage: text => [failureMessage(watcherOf(text), reportOf(text), { known: [], log: `/logs/${text}` }), failureMessage(watcherOf(text), reportOf(text), { known: [], log: undefined, origin: 'outside' })],
  revertMessage: text => [revertMessage([revertedOf(text)], { restored: [text || 'file'], remaining: [`${text}2`], late: [`${text}3`], skipped: [text || 'submodule'] }, refOf(text), { staged: true })],
  'revertMessage of a revert changed again': text => [revertMessage([revertedOf(text)], { restored: [], remaining: [text || 'file'], isRemainingNew: true }, null)],
  'revertMessage of files not listed': text => [revertMessage([revertedOf(text)], { restored: [], skipped: [text || 'submodule'], isUnlisted: true }, undefined)],
  unrevertedMessage: text => [unrevertedMessage(refOf(text), { failed: 'git', files: { asHead: [text || 'file'], still: [`${text}2`], late: [`${text}3`] }, causes: [revertedOf(text)] }), unrevertedMessage(null, { failed: 'unknown', files: undefined, causes: [revertedOf(text), revertedOf(`${text}2`)] })],
  recoveryMessage: text => [recoveryMessage(watcherOf(text), reportOf(text))],
  environmentLine: text => [environmentLine(watcherOf(text), text || 'environment')],
  exitMessage: text => [exitMessage(watcherOf(text), RETRY_MS)],
  gaveUpMessage: text => [gaveUpMessage(watcherOf(text), REPEATED_EXITS, RETRY_MS, `/logs/${text || 'log'}`)],
  statusLine: text => [statusLine(watcherOf(text), reportOf(text))],
  guardedFailure: text => {
    const live = { watcher: watcherOf(text), report: reportOf(text), baseline: undefined }
    return [guardedFailure({ liveWatchers: [{ ...live, baseline: { ...reportOf('x'), isFailed: false, failures: [] } }] } as unknown as State, { inherited: 'block' }) ?? '']
  },
  notice: text => [notice(undefined, pausedFor(`${text} the revert in ${text} failed: ${text}`)) ?? '', notice(undefined, pausedFor(text || 'reason')) ?? ''],
  refusedBecause: text => [refusedBecause([{ path: text || 'path', rule: text || 'rule', line: 3 }])],
  changedBecause: text => [changedBecause([text || 'file'], [text || 'check'], 'otherwise'), changedBecause([text || 'file'], [text || 'check', `${text}2`], 'otherwise')],
  changedOutside: text => [changedOutside([text || 'file'], 'otherwise'), changedOutside([text || 'file', `${text}2`], 'otherwise')],
  heldBecause: text => [heldBecause([text || 'check', `${text}2`])],
  leftUncommitted: text => [leftUncommitted(`${text} ${text}`), leftUncommitted(text || 'reason')],
  listed: text => [listed([text || 'file'])],
  cameBackLine: text => [cameBackLine({ restored: [text || 'file'], skipped: [text || 'submodule'] }), cameBackLine({ restored: [] })],
  leftLine: text => [leftLine({ restored: ['clean.txt'], remaining: [text || 'file'], late: [`${text}2`] }), leftLine({ restored: [], remaining: [text || 'file'], isRemainingNew: true })],
}

/** A text with no meaning for any builder that ends as the text does, in a full stop or not. */
const neutralLike = (text: string) => (text.endsWith('.') ? `${NEUTRAL}.` : NEUTRAL)
const own = (build: Builder) => build(NEUTRAL).flatMap(text => text.split(LINE_BREAK_PATTERN)).filter(line => line.startsWith('overwatch'))
const noticeLines = (build: Builder, text: string) => build(text).flatMap(built => built.split(LINE_BREAK_PATTERN))
const writtenForms = (text: string) => [...new Set([text, safeName(text), safePath(text), safeLine(text)])].sort((a, b) => b.length - a.length)

longTest('every builder gives a notice for each hostile text', () => {
  let count = 0
  for (const [name, build] of Object.entries(BUILDERS)) {
    for (const text of HOSTILE) {
      const built = build(text)
      expect({ name, text: text.slice(0, 30), built: built.length > 0 && built.every(each => each !== '') }).toEqual({ name, text: text.slice(0, 30), built: true })
      count += 1
    }
  }
  expect(count).toBe(Object.keys(BUILDERS).length * HOSTILE.length)
})

longTest('a text that starts a line of overwatch\'s own after any line break does not do so in any notice', () => {
  for (const [name, build] of Object.entries(BUILDERS)) {
    for (const lineBreak of LINE_BREAKS) {
      const lines = noticeLines(build, `x${lineBreak}${FORGED_TAIL}`)
      expect({ name, lineBreak, own: lines.filter(line => line.startsWith('overwatch:')).length }).toEqual({ name, lineBreak, own: own(build).length })
      expect({ name, lineBreak, forged: lines.some(line => line.startsWith(FORGED_TAIL)) }).toEqual({ name, lineBreak, forged: false })
    }
  }
})

longTest('a command whose argument holds hostile text starts no line and carries no line break or control character raw', () => {
  const hiding = /[\u0085\u2028\u2029]/
  for (const lineBreak of LINE_BREAKS) {
    const lines = failureMessage(watcherOf('check', `x${lineBreak}${FORGED_TAIL}`), reportOf('summary'), { known: [], log: undefined }).split(LINE_BREAK_PATTERN)
    expect(lines.filter(line => line.startsWith('overwatch:')).length).toBe(1)
  }
  for (const text of HOSTILE) expect(hiding.test(failureMessage(watcherOf('check', text), reportOf('summary'), { known: [], log: undefined }))).toBe(false)
})

longTest('no notice carries a line break or a control character raw', () => {
  const hiding = /[\u0085\u2028\u2029]/
  for (const [name, build] of Object.entries(BUILDERS)) {
    for (const text of ['c1\u0085control', 'sep\u2028arator']) {
      expect({ name, text, hidden: build(text).some(built => hiding.test(built)) }).toEqual({ name, text, hidden: false })
    }
  }
})

const HIDING_TEXTS = ['bidi\u202eoverride', 'zero\u200bwidth', 'bom\ufeff', 'no\u00a0break']
const ANY_HIDING = /[\u202e\u200b\ufeff\u00a0]/
const PLACES_OF_A_NAME = 4

longTest('a file name and a summary carry no character that hides text raw', () => {
  for (const text of HIDING_TEXTS) {
    const summarised = failureMessage(watcherOf('check'), { summary: text, isFailed: true, text: 'took 5ms', failures: [] }, { known: [], log: undefined })
    expect({ text, files: ANY_HIDING.test(listed([text])), summary: ANY_HIDING.test(summarised) }).toEqual({ text, files: false, summary: false })
  }
})

longTest('the command, the directory, the check name and a failing test keep what is no line break or control character', () => {
  for (const text of HIDING_TEXTS) {
    const told = failureMessage(watcherOf(text, text), { summary: 'summary', isFailed: true, text: 'took 5ms', failures: [text] }, { known: [], log: undefined })
    expect({ text, kept: told.split(text).length - 1 }).toEqual({ text, kept: PLACES_OF_A_NAME })
  }
})

longTest('what a builder adds around a text does not depend on the text', () => {
  const compared: Record<string, number> = {}
  for (const [name, build] of Object.entries(BUILDERS)) {
    for (const text of HOSTILE) {
      const neutral = neutralLike(text)
      const expected = build(neutral)
      if (text === '' || text.length > NAME_LIMIT || SENTENCES.includes(text) || expected.some(fixed => fixed.includes(text))) continue
      const substituted = build(text).map(built => writtenForms(text).reduce((left, form) => left.split(form).join(neutral), built))
      expect({ name, text: text.slice(0, 30), substituted }).toEqual({ name, text: text.slice(0, 30), substituted: expected })
      compared[name] = (compared[name] ?? 0) + 1
    }
  }
  expect(Object.keys(compared).sort()).toEqual(Object.keys(BUILDERS).sort())
  expect(Math.min(...Object.values(compared))).toBeGreaterThan((HOSTILE.length - SENTENCES.length) / 2)
})

longTest('every builder the registry names is in the matrix', () => {
  expect(Object.keys(registry.covered).length).toBeGreaterThan(0)
  expect(Object.values(registry.covered).filter(builder => !(builder in BUILDERS))).toEqual([])
  expect(Object.values(registry.notBuiltFromAText).filter(reason => reason === '')).toEqual([])
})

longTest('safeName, safePath and safeLine write each case of the table the engine writes the same', () => {
  for (const { name, input, safeName: forName, safePath: forPath, safeLine: forLine } of cases) {
    expect({ name, written: [safeName(input), safePath(input), safeLine(input)] }).toEqual({ name, written: [forName, forPath, forLine] })
  }
})

longTest('a code point above the basic plane is written as one escape, and a name is cut by characters, not by halves of one', () => {
  expect(safeName('a\u{e0041}b')).toBe('a\\U000e0041b')
  expect(safeLine('a\u{e0041}b')).toBe('a\\U000e0041b')
  expect(safePath('a\u{e0041}b')).toBe('a\u{e0041}b')
  const cut = safeName('\u{1f600}'.repeat(NAME_LIMIT + 1))
  expect([...cut].length).toBe(NAME_LIMIT - '...'.length + '...'.length)
  expect(cut.endsWith('...')).toBe(true)
  expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
})

longTest('a name is cut to the limit with a mark, and a path or a line is not cut', () => {
  const name = safeName('n'.repeat(NAME_LIMIT * 5))
  expect([name.length, name.endsWith('...')]).toEqual([NAME_LIMIT, true])
  expect(safeName('n'.repeat(NAME_LIMIT))).toBe('n'.repeat(NAME_LIMIT))
  expect(safePath('p'.repeat(NAME_LIMIT * 5)).length).toBe(NAME_LIMIT * 5)
  expect(safeLine('l'.repeat(NAME_LIMIT * 5)).length).toBe(NAME_LIMIT * 5)
})

longTest('the plain space is kept, a backtick is written only where it would end quotes, and a name never holds one', () => {
  expect(safeName('a b')).toBe('a b')
  expect(safeLine('a`b')).toBe('a`b')
  expect(safeName('a`b')).toBe('a\\x60b')
  expect(listed(['a`b'])).toBe('`a\\x60b`')
  expect(listed(['a\nb'])).toBe('`a\\x0ab`')
})
