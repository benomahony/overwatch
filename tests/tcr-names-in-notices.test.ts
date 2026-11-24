import { expect } from 'claude-code/testing'
import { changedBecause, heldBecause } from '../hooks/hold-notices'
import { cameBackLine, leftLine, listed } from '../hooks/notice-files'
import { revertMessage, unrevertedMessage } from '../hooks/revert-notices'
import { refusedBecause } from '../hooks/tcr'
import { safeName } from '../hooks/safe-text'
import type { Report, Watcher } from '../hooks/watchers'
import { longTest } from './fixtures/tcr-session'

const BACKTICK = '`'
const SHOWN_NAMES = 5
const REFUSALS = 30
const LONG_NAME = 'n'.repeat(500)
const HIDING_TEXTS = ['bidi\u202eoverride', 'zero\u200bwidth', 'bom\ufeff', 'no\u00a0break', 'tag\u{e0041}char', 'c1\u0085control', 'sep\u2028arator', 'para\u2029graph', 'line\nbreak', 'del\u007f', 'null\u0000byte']
const RAW_HIDING = /[\u202e\u200b\ufeff\u00a0\u{e0041}\u0085\u2028\u2029\u007f\u0000]/u
const NEUTRAL = 'neutral'
const DOLLAR_NAMES = ['sub$', 'a$&b', 'a$`b', "a$'b", '$1', '$$', 'x$<n>y']

const watcher: Watcher = { name: 'check', marker: 'marker', argv: ['pytest'], dir: 'dir' }
const report: Report = { summary: 'summary', isFailed: true, text: 'took 5ms', failures: ['failure'] }
const reverted = { watcher, report, known: [], log: '/logs/log' }

type NameBuilder = (name: string) => string[]

/** Each notice the engine writes with its names through `safe_name`, as a function of one name put in every place of it that holds a file name. */
const NAME_BUILDERS: Record<string, NameBuilder> = {
  listed: name => [listed([name])],
  'refusedBecause by path': name => [refusedBecause([{ path: name, rule: 'rule', line: null }])],
  'refusedBecause by rule': name => [refusedBecause([{ path: 'path', rule: name, line: 3 }])],
  cameBackLine: name => [cameBackLine({ restored: [name], skipped: [name] })],
  'cameBackLine submodules': name => [cameBackLine({ restored: [], skipped: [name] })],
  leftLine: name => [leftLine({ restored: [], remaining: [name], late: [name] })],
  revertMessage: name => [revertMessage([reverted], { restored: [name], remaining: [name], late: [name], skipped: [name] }, null, { staged: false })],
  changedBecause: name => [changedBecause([name], ['check'], 'other')],
  'changedBecause check names': name => [changedBecause(['file'], [name], 'other'), changedBecause(['file'], [name, 'other'], 'other')],
  'unrevertedMessage check names': name => [unrevertedMessage(null, { failed: 'git', files: undefined, causes: [{ ...reverted, watcher: { ...watcher, name } }] })],
  unrevertedMessage: name => [unrevertedMessage(null, { failed: 'git', files: { asHead: [name], still: [name], late: [name] }, causes: [reverted] })],
}

const raw = (texts: string[], name: string) => texts.some(text => RAW_HIDING.test(text) || text.includes(name))
const backticks = (texts: string[]) => texts.join('').split(BACKTICK).length - 1

for (const [builder, build] of Object.entries(NAME_BUILDERS)) {
  for (const name of HIDING_TEXTS) {
    longTest(`${builder} writes the name ${JSON.stringify(name)} with no character that hides text raw`, () => {
      expect(raw(build(name), name)).toBe(false)
    })
  }
  longTest(`${builder} writes a backtick in a name as an escape, so that it cannot end the quotes around the name`, () => {
    expect(backticks(build('back`tick'))).toBe(backticks(build(NEUTRAL)))
  })
  longTest(`${builder} cuts a name of ${LONG_NAME.length} characters`, () => {
    const built = build(LONG_NAME).join('')
    expect(built).not.toContain(LONG_NAME)
    expect(built).toContain('...')
  })
}

for (const [builder, build] of Object.entries(NAME_BUILDERS)) {
  for (const name of DOLLAR_NAMES) {
    longTest(`${builder} writes the name ${JSON.stringify(name)} as it is: a $ in a name is no instruction to the text it is put in`, () => {
      expect(build(name).some(text => text.includes(safeName(name)))).toBe(true)
    })
  }
}

longTest('a notice of refused files names five of them, each in quotes and written as the engine writes it, and counts the rest', () => {
  const refused = Array.from({ length: REFUSALS }, (_, index) => ({ path: `f${index}\u202e\`x`, rule: 'name pattern', line: null }))
  const reason = refusedBecause(refused)
  expect(reason.split(BACKTICK + 'f').length - 1).toBe(SHOWN_NAMES)
  expect(reason).toContain(`and ${REFUSALS - SHOWN_NAMES} more`)
  expect(reason).not.toContain('\u202e')
  expect(reason.length).toBeLessThan(520)
})

longTest('a refusal of one line of a file names the path, the line and the rule inside one pair of quotes', () => {
  expect(refusedBecause([{ path: 'src/a.py', rule: 'AWS access key', line: 12 }])).toContain('`src/a.py:12 (AWS access key)`')
})

longTest('a notice of the checks that wrote files names each check bare, once, in sorted order, as the engine writes them', () => {
  expect(changedBecause(['f'], ['b', 'a'], 'o')).toContain('one of the checks a, b wrote files')
  expect(changedBecause(['f'], ['a', 'a'], 'o')).toContain('the check a wrote files')
  expect(changedBecause(['f'], ['zanity'], 'o')).toContain('the check zanity wrote files (`f`)')
})

longTest('checks are named in the order of their code points, which is the engine\'s order: a character above the basic plane follows the last of it', () => {
  expect(changedBecause(['f'], ['\u{10000}', '\uffff'], 'o')).toContain('one of the checks \uffff, \u{10000} wrote files')
  expect(changedBecause(['f'], ['b', '\u{1f600}', 'a', '\ud7ff'], 'o')).toContain('one of the checks a, b, \ud7ff, \u{1f600} wrote files')
  expect(changedBecause(['f'], ['ab', 'a'], 'o')).toContain('one of the checks a, ab wrote files')
})

longTest('a check that failed with no earlier result is written with an escape for line breaks and control characters and nothing else, as the README says', () => {
  expect(heldBecause(['a\nb', 'a\u200bb', 'a`b'])).toBe('overwatch: TCR held the edit: a\\x0ab, a\u200bb, a`b failed and has no earlier result to compare with')
})

longTest('a check that wrote files is written with an escape for each hiding character and backtick, cut after 200 characters, which is stronger than the engine\'s raw name', () => {
  expect(changedBecause(['f'], ['a\u200bb'], 'o')).toContain('the check a\\u200bb wrote files')
  expect(changedBecause(['f'], ['a`b'], 'o')).toContain('the check a\\x60b wrote files')
  expect(changedBecause(['f'], ['a'.repeat(250)], 'o')).toContain(`the check ${'a'.repeat(197)}... wrote files`)
})
