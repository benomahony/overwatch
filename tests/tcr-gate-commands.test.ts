import { expect } from 'claude-code/testing'
import { bringsInFiles, commandOf, protectedChecks, readGate } from '../hooks/gating'
import { longTest } from './fixtures/tcr-session'

const OVERRIDE = '.overwatch.json'

type Pattern = { pattern: string; python: boolean; javascript: boolean; accepted: boolean }

/** Patterns of a protected action's command, with whether Python's re and JavaScript's RegExp take each, and whether the plugin does. */
const PATTERNS: Pattern[] = [
  { pattern: '^git push', python: true, javascript: true, accepted: true },
  { pattern: '\\d+', python: true, javascript: true, accepted: true },
  { pattern: '(?P<n>x)', python: true, javascript: false, accepted: true },
  { pattern: '(?P<n>x)(?P=n)', python: true, javascript: false, accepted: true },
  { pattern: '(?<n>x)', python: false, javascript: true, accepted: true },
  { pattern: '(?i)git', python: true, javascript: false, accepted: false },
  { pattern: 'a++', python: true, javascript: false, accepted: false },
  { pattern: '(', python: false, javascript: false, accepted: false },
  { pattern: '[', python: false, javascript: false, accepted: false },
  { pattern: 'a{2,1}', python: false, javascript: false, accepted: false },
]

for (const { pattern, python, javascript, accepted } of PATTERNS) {
  longTest(`the pattern ${pattern}, which Python ${python ? 'takes' : 'rejects'} and JavaScript ${javascript ? 'takes' : 'rejects'}, is ${accepted ? 'kept in' : 'dropped from'} the gate`, () => {
    const read = () => readGate({ gate: { protected_actions: [{ tool: 'Bash', command: pattern }] } })
    if (accepted) expect(read().protected_actions?.[0]?.command).toBe(pattern)
    else expect(read).toThrow(`Bash's command ${pattern} is not a valid regular expression`)
  })
}

longTest('a pattern written with Python\'s named group and its reference matches what Python matches', () => {
  const policy = readGate({ gate: { protected_actions: [{ tool: 'Bash', command: '^(?P<word>a)(?P=word)$' }] } })
  expect(protectedChecks('Bash', { command: 'aa' }, policy)).toEqual([])
  expect(protectedChecks('Bash', { command: 'ab' }, policy)).toBeUndefined()
})

longTest('a malformed pattern names the tool and the file to fix', () => {
  expect(() => readGate({ gate: { protected_actions: [{ tool: 'Edit', command: '(' }] } })).toThrow(`fix it in ${OVERRIDE}`)
})

longTest('an argument list is joined as Python quotes it, so that a pattern matches the command it names', () => {
  const policy = readGate({ gate: { protected_actions: [{ tool: 'Bash', command: "^git commit -m 'a b'$" }] } })
  expect(commandOf({ command: ['git', 'commit', '-m', 'a b'] })).toBe("git commit -m 'a b'")
  expect(protectedChecks('Bash', { command: ['git', 'commit', '-m', 'a b'] }, policy)).toEqual([])
})

longTest('an argument list quotes the empty word and a quote, and one that holds no text is no command', () => {
  expect(commandOf({ cmd: ['echo', '', "it's"] })).toBe(`echo '' 'it'"'"'s'`)
  expect(commandOf({ command: ['echo', 5] })).toBe('')
})

longTest('an argument list that brings in files is read as the command it is', () => {
  expect(bringsInFiles(commandOf({ command: ['git', 'merge', 'x'] }))).toBe(true)
})

longTest('a tool call whose command is present but null has no command, as in the engine, and cmd is not read then', () => {
  expect(commandOf({ command: null, cmd: 'git push' })).toBe('')
  expect(commandOf({ cmd: 'git push' })).toBe('git push')
  expect(commandOf({ command: 'git status', cmd: 'git push' })).toBe('git status')
})
