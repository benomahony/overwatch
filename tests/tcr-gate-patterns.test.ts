import { expect } from 'claude-code/testing'
import { protectedChecks, readGate } from '../hooks/gating'
import { longTest } from './fixtures/tcr-session'

const gateOf = (command: string) => readGate({ gate: { protected_actions: [{ tool: 'Bash', command }] } })
const checksFor = (command: string, run: string) => protectedChecks('Bash', { command: run }, gateOf(command))

longTest('a pattern that ends in $ protects the command with a line break after it, as Python does', () => {
  expect(checksFor('^git push$', 'git push\n')).toEqual([])
  expect(checksFor('^git push$', 'git push')).toEqual([])
})

longTest('a pattern that ends in $ does not protect a command that goes on after the line break, as Python does not', () => {
  expect(checksFor('^git push$', 'git push\nls')).toBeUndefined()
  expect(checksFor('^git push$', 'git push now')).toBeUndefined()
})

longTest('a $ that is an escape or stands in a character class is no end of the text', () => {
  expect(checksFor('cost \\$5', 'cost $5')).toEqual([])
  expect(checksFor('^[$]x', '$x')).toEqual([])
  expect(checksFor('^[$]x', 'x')).toBeUndefined()
  expect(checksFor('a\\\\$', 'a\\')).toEqual([])
})

longTest('a $ in the middle of a pattern ends the text there, as in Python', () => {
  expect(checksFor('a$|b', 'a\n')).toEqual([])
  expect(checksFor('a$|b', 'ab')).toEqual([])
  expect(checksFor('a$ b', 'a b')).toBeUndefined()
})

const ARABIC_INDIC_THREE = '٣'
const E_ACUTE = 'é'

longTest('a limit: \\d, \\w and \\b read ASCII only, where Python reads every Unicode digit, letter and word boundary, so a command written with such characters can be protected in one and not in the other', () => {
  expect(checksFor('^rm \\d$', `rm ${ARABIC_INDIC_THREE}`)).toBeUndefined()
  expect(checksFor('^rm \\w+$', `rm ${E_ACUTE}`)).toBeUndefined()
  expect(checksFor(`rm\\b${E_ACUTE}`, `rm${E_ACUTE}`)).toEqual([])
  expect(checksFor('^rm \\d$', 'rm 3')).toEqual([])
})

longTest('\\A and \\Z outside a character class are the start and the end of the text, as in Python, and no letters', () => {
  expect(checksFor('\\Agit push\\Z', 'git push')).toEqual([])
  expect(checksFor('\\Agit push\\Z', 'git push\n')).toBeUndefined()
  expect(checksFor('\\Agit push\\Z', 'x git push')).toBeUndefined()
  expect(checksFor('\\Agit push', 'git push now')).toEqual([])
  expect(checksFor('\\Agit push', 'x git push')).toBeUndefined()
  expect(checksFor('push\\Z', 'git push')).toEqual([])
  expect(checksFor('push\\Z', 'git pushZ')).toBeUndefined()
  expect(checksFor('^a\\Zb', 'aZb')).toBeUndefined()
})

longTest('a \\Z in a character class is left to JavaScript, which reads it as the letter Z', () => {
  expect(checksFor('^[\\Z]$', 'Z')).toEqual([])
})

longTest('a [ in a pattern starts a character class in which $ is a character, so the pattern ^[^$]$ protects the command "("', () => {
  expect(checksFor('^[^$]$', '(')).toEqual([])
  expect(checksFor('^[^$]$', '$')).toBeUndefined()
})
