import { expect } from 'claude-code/testing'
import { SENTENCES } from './fixtures/notice-sentences'
import { bringsInFiles, commandOf, protectedChecks } from '../hooks/gating'
import { longTest } from './fixtures/tcr-session'

const ALPHABET = ["'", '"', '\\', ' ', '\t', '\n', ';', '&', '|', '(', ')', '`', '$', 'git', 'gh', 'sh -c', 'env', 'sudo', 'if', 'then', 'merge', 'pull', 'x=1', '-', '/', '--', 'é', ' ', '\ud800', '']
const FUZZ_COUNT = 3000
const FUZZ_LENGTH = 12
const LCG_MULTIPLIER = 1103515245
const LCG_INCREMENT = 12345
const LCG_MODULUS = 2 ** 31
const WRAPS = [(text: string) => text, (text: string) => `git merge x; ${text}`, (text: string) => `sh -c '${text}'`, (text: string) => `bash -c "${text}"`, (text: string) => `env A=1 sudo ${text}`, (text: string) => `if git pull; then ${text}; fi`]
const POLICY = { protected_actions: [{ tool: 'Bash' }, { tool: 'bash', command: 'git' }] }

function fuzzed(): string[] {
  let seed = 1
  const next = () => {
    seed = (seed * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS
    return seed
  }
  return Array.from({ length: FUZZ_COUNT }, () => Array.from({ length: FUZZ_LENGTH }, () => ALPHABET[next() % ALPHABET.length]).join(''))
}

longTest('no text of the matrix, wrapped as a shell would run it, and no pseudo-random mix of quotes and operators breaks the parser of the agent\'s command', () => {
  const texts = [...SENTENCES, ...fuzzed()]
  let parsed = 0
  for (const text of texts) {
    for (const wrap of WRAPS) {
      const command = wrap(text)
      expect({ command: command.slice(0, 60), brings: typeof bringsInFiles(command) }).toEqual({ command: command.slice(0, 60), brings: 'boolean' })
      expect(protectedChecks('Bash', { command }, POLICY)).toEqual([])
      expect(commandOf({ cmd: command })).toBe(command)
      parsed += 1
    }
  }
  expect(parsed).toBe(texts.length * WRAPS.length)
})
