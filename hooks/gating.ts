import { assert } from './assert'
import { CommandError } from './tcr'
import { pythonRepr } from './tcr-settings'
import { OVERRIDE_PATH, type Override } from './watchers'

/** Only explicitly protected actions are subject to a pre-tool failure gate. */
export type GatePolicy = {
  inherited?: 'allow' | 'block'
  protected_actions?: { tool: string; command?: string; checks?: string[] }[]
}

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/
const SINGLE_QUOTE = /'/g
const QUOTED_SINGLE_QUOTE = `'"'"'`

/** One argument as Python's shlex.quote writes it, so that a word keeps its bounds in the joined command. */
function quotedWord(word: string): string {
  assert(typeof word === 'string', `an argument of ${typeof word} was quoted; quote text`)
  const quoted = word === '' ? "''" : SAFE_SHELL_WORD.test(word) ? word : `'${word.replace(SINGLE_QUOTE, QUOTED_SINGLE_QUOTE)}'`
  assert(quoted.length >= word.length, `the argument ${word} was quoted as ${quoted}, which is shorter; only add quotes`)
  return quoted
}

/** The shell command a tool call runs, from its command or cmd argument: text as it is, an argument list joined as Python's shlex.join joins it; empty when it has neither. */
export function commandOf(input: object): string {
  const arguments_ = input as Record<string, unknown>
  const given = 'command' in arguments_ ? arguments_.command : arguments_.cmd
  const isArgumentList = Array.isArray(given) && given.every(part => typeof part === 'string')
  const command = typeof given === 'string' ? given : isArgumentList ? (given as string[]).map(quotedWord).join(' ') : ''
  assert(typeof command === 'string', `a tool call's command read as ${typeof command}; read it as text`)
  assert(given !== undefined || command.length === 0, `a tool call with no command gave ${command.length} characters; give none as empty text`)
  return command
}

/**
 * One shell token: an operator (&&, ||, ;, &, |, parentheses, a new line or a backtick), or a word made of plain
 * characters and quoted parts. A quote that never closes matches nothing and is skipped.
 */
const SHELL_TOKEN = /[ \t\r]*(?:(&&|\|\||[;&|()\n`])|((?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^ \t\r\n;&|()`'"\\])+))/g
const QUOTED_PART = /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g
const ESCAPED_CHARACTER = /\\(.)/g
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELLS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh'])
/** Words that run the command after them, so the command after them is the one that matters. */
const WRAPPERS = new Set(['command', 'env', 'exec', 'nohup', 'sudo', 'time'])
/** Shell control words, which can stand before a command: if git merge x; then git commit; fi */
const CONTROL_WORDS = new Set(['!', '{', '}', 'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'if', 'in', 'then', 'until', 'while'])
/** Git subcommands that can bring files into the workspace from somewhere other than the agent's own edits. */
const FILE_BRINGING = new Set(['am', 'apply', 'checkout', 'cherry-pick', 'merge', 'pull', 'read-tree', 'rebase', 'reset', 'restore', 'revert', 'stash', 'submodule', 'switch'])
/** The same for the GitHub CLI, whose subcommands come in pairs. */
const GH_FILE_BRINGING = new Set(['pr checkout', 'pr merge', 'repo sync'])
/** Git options that take the next word as their value, so it is not the subcommand. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
/** How many levels of shell -c scripts, as in sh -c 'sh -c "git merge x"', are read for a git command. */
const SCRIPT_DEPTH = 3

/** The last part of a path, as /usr/bin/git gives git; empty when there is no word. */
function baseName(word: string | undefined): string {
  const name = (word ?? '').split('/').pop() ?? ''
  assert(!name.includes('/'), `${JSON.stringify(name)} still holds a slash after ${JSON.stringify(word)} was split at each one`)
  assert(name.length <= (word ?? '').length, `${JSON.stringify(name)} is longer than the word ${JSON.stringify(word)} it came from`)
  return name
}

/** `word` as the shell passes it on: its quotes removed and its backslashes dropped. */
function unquoted(word: string): string {
  const result = word.replace(QUOTED_PART, (_, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
    single ?? (double === undefined ? escaped ?? '' : double.replace(ESCAPED_CHARACTER, '$1')))
  assert(typeof word === 'string' && typeof result === 'string', `the word ${typeof word} was unquoted to ${typeof result}`)
  assert(result.length <= word.length, `a word of ${word.length} characters was unquoted to ${result.length}, which is longer`)
  return result
}

/**
 * The simple commands in `text`, each as its words, split at the operators &&, ||, ;, &, |, parentheses, new lines
 * and backticks, which are shell syntax only outside quotes. A quoted string stays one word.
 */
function shellCommands(text: string): string[][] {
  const commands: string[][] = [[]]
  for (const found of text.matchAll(SHELL_TOKEN)) {
    if (found[1] !== undefined) commands.push([])
    else commands[commands.length - 1]!.push(unquoted(found[2] ?? ''))
  }
  const kept = commands.filter(words => words.length > 0)
  assert(kept.every(words => words.length > 0), `commands ${JSON.stringify(kept)} include an empty one; drop empty commands`)
  assert(kept.length <= text.length + 1, `${kept.length} commands from ${text.length} characters; split each operator once`)
  return kept
}

/**
 * Whether `word` stands before the command that runs: a VAR=value assignment, a wrapper such as env or sudo, or a shell
 * control word such as if, then, do or !.
 */
function isPrefix(word: string): boolean {
  const prefix = ASSIGNMENT.test(word) || WRAPPERS.has(word) || CONTROL_WORDS.has(word)
  assert(!prefix || word !== '', `the empty word ${JSON.stringify(word)} counted as a prefix (${prefix}); skip empty words before asking`)
  assert(!prefix || ASSIGNMENT.test(word) || WRAPPERS.has(word) || CONTROL_WORDS.has(word), `${JSON.stringify(word)} counted as a prefix of no kind`)
  return prefix
}

/**
 * The index in `words` of the command that runs: past leading VAR=value assignments, wrappers such as env or sudo, and
 * shell control words such as if, then, do or !.
 */
function commandStart(words: readonly string[]): number {
  let index = 0
  while (index < words.length && isPrefix(words[index]!)) index++
  const rest = words.slice(index)
  assert(index >= 0 && index <= words.length, `index ${index} is outside the ${words.length} words; stop at the end`)
  assert(rest.length === 0 || !isPrefix(rest[0]!), `${JSON.stringify(rest.slice(0, 1))} is a prefix, not the command`)
  return index
}

/** The script a shell command runs with -c, as in bash -lc 'git merge x'; undefined when `words` are no shell with -c. */
function shellScript(words: readonly string[]): string | undefined {
  let script: string | undefined
  if (SHELLS.has(baseName(words[0]))) {
    const flagged = words.findIndex((word, index) => index > 0 && word.startsWith('-') && !word.startsWith('--') && word.includes('c'))
    if (flagged > 0 && flagged + 1 < words.length) script = words[flagged + 1]
  }
  assert(script === undefined || SHELLS.has(baseName(words[0])), `${JSON.stringify(words)} gave script ${script} without a shell`)
  assert(script === undefined || words.includes(script), `script ${script} is not among the words ${JSON.stringify(words)}`)
  return script
}

/**
 * The git subcommand of the command `words` run: the first word after git that is no option and no option's value.
 * Undefined when they do not run git, or run it with no subcommand.
 */
function gitSubcommand(words: readonly string[]): string | undefined {
  let found: string | undefined
  for (let index = 1; baseName(words[0]) === 'git' && index < words.length && found === undefined; index++) {
    const word = words[index]!
    if (GIT_VALUE_OPTIONS.has(word)) index++
    else if (word !== '' && !word.startsWith('-')) found = word
  }
  assert(found === undefined || baseName(words[0]) === 'git', `found ${found} in ${JSON.stringify(words)}, which do not run git`)
  assert(found === undefined || !found.startsWith('-'), `${found} is an option, not a subcommand; skip options`)
  return found
}

/** The first two non-option words after gh, as pr merge; undefined when `words` do not run gh. */
function ghSubcommand(words: readonly string[]): string | undefined {
  const found = baseName(words[0]) === 'gh' ? words.slice(1).filter(word => !word.startsWith('-')).slice(0, 2).join(' ') : undefined
  assert(Array.isArray(words), `the words of a command are ${typeof words}, not a list`)
  assert(found === undefined || words.length > 0, `a gh subcommand was found in ${words.length} words`)
  return found
}

/**
 * Whether `command` runs a git or gh operation that can bring in files the agent did not write, as a merge, pull or
 * cherry-pick can. Such a command may leave a plain commit in the reflog while the workspace holds another's changes.
 * Only commands that run git or gh count, so a commit message that names a merge does not.
 */
export function bringsInFiles(command: string): boolean {
  let scripts = [command]
  let found = false
  for (let depth = 0; depth < SCRIPT_DEPTH; depth++) {
    const nested: string[] = []
    for (const script of scripts) {
      for (const all of shellCommands(script)) {
        const words = all.slice(commandStart(all))
        const inner = shellScript(words)
        if (inner !== undefined) nested.push(inner)
        found = found || FILE_BRINGING.has(gitSubcommand(words) ?? '') || GH_FILE_BRINGING.has(ghSubcommand(words) ?? '')
      }
    }
    scripts = nested
  }
  assert(typeof found === 'boolean', `${found} is not a yes or no; combine the checks with ||`)
  assert(!found || command.trim() !== '', `the empty command ${JSON.stringify(command)} brought in files; read the commands first`)
  return found
}

/** The gate of `.overwatch.json` is malformed; the message names the field and what to change, as the Python engine's does. */
export class PolicyError extends CommandError {}

const INHERITED_VALUES = ['allow', 'block']

/** `value` as Python's str() writes it into a message: text as it is, anything else as its repr. */
function pythonText(value: unknown): string {
  assert(typeof value !== 'function' && typeof value !== 'symbol', `${String(value)} came from JSON but is a ${typeof value}`)
  const text = typeof value === 'string' ? value : value === undefined ? 'None' : pythonRepr(value)
  assert(typeof value !== 'bigint', `${String(value)} came from JSON but is a ${typeof value}`)
  return text
}

const PYTHON_NAMED_GROUP = /\(\?P</g
const PYTHON_GROUP_REFERENCE = /\(\?P=(\w+)\)/g

const PYTHON_END = '(?=\\n?$)'
const PYTHON_TEXT_START = '^'
const PYTHON_TEXT_END = '(?![\\s\\S])'
const PYTHON_ANCHORS: Record<string, string> = { A: PYTHON_TEXT_START, Z: PYTHON_TEXT_END }

/** The pattern with each `$` that is no escape and stands outside a character class written as Python reads it: the end of the text, or the end before a last line break; and `\A` and `\Z` outside a class as the start and the end of the text, which JavaScript reads as the letters A and Z. */
function withPythonEnds(pattern: string): string {
  assert(typeof pattern === 'string', `the ends of a pattern of ${typeof pattern} were written; give text`)
  let written = ''
  let isClass = false
  for (let at = 0; at < pattern.length; at += 1) {
    const character = pattern[at] as string
    if (character === '\\') {
      const anchor = isClass ? undefined : PYTHON_ANCHORS[pattern[at + 1] ?? '']
      written += anchor ?? character + (pattern[at + 1] ?? '')
      at += 1
    } else if (character === '$' && !isClass) {
      written += PYTHON_END
    } else {
      if (character === '[') isClass = true
      if (character === ']') isClass = false
      written += character
    }
  }
  assert(typeof written === 'string' && !isClass || written !== undefined, `the pattern was written as ${typeof written}, not text`)
  return written
}

/** The pattern as a regular expression: a pattern that JavaScript rejects is read with Python's named-group syntax, `(?P<name>` and `(?P=name)`, written as JavaScript's own, and `$` ends the text before a last line break too, as in Python, so that `^git push$` protects "git push\n". */
export function patternOf(pattern: string): RegExp {
  assert(typeof pattern === 'string', `a pattern of ${typeof pattern} was compiled; compile text`)
  let compiled: RegExp
  try {
    compiled = new RegExp(withPythonEnds(pattern))
  } catch (error) {
    const translated = pattern.replace(PYTHON_NAMED_GROUP, '(?<').replace(PYTHON_GROUP_REFERENCE, '\\k<$1>')
    if (translated === pattern) throw error
    compiled = new RegExp(withPythonEnds(translated))
  }
  assert(compiled instanceof RegExp, `the pattern ${pattern} compiled to ${typeof compiled}, not a regular expression`)
  return compiled
}

/** The pattern of a protected action's command, which must be text that is a regular expression when it is given. */
function checkedCommand(tool: string, command: unknown): string | undefined {
  assert(typeof tool === 'string', `the tool of a protected action is ${typeof tool}, not text`)
  assert(command === undefined || command === null || typeof command === 'string' || typeof command === 'number' || typeof command === 'boolean' || typeof command === 'object', `the command of ${tool} is ${typeof command}, which JSON never holds`)
  if (command === undefined || command === null) return undefined
  if (typeof command !== 'string') throw new PolicyError(`${tool}'s command must be a regular expression string, not ${pythonText(command)}; fix it in ${OVERRIDE_PATH}`)
  try {
    patternOf(command)
  } catch (error) {
    throw new PolicyError(`${tool}'s command ${command} is not a valid regular expression (${String(error)}); fix it in ${OVERRIDE_PATH}`)
  }
  return command
}

/** One entry of `gate.protected_actions`, checked as the Python engine's parse_action checks it. */
function checkedAction(action: unknown): { tool: string; command?: string; checks?: string[] } {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) throw new PolicyError(`gate.protected_actions entry ${pythonText(action)} must be an object with a tool; fix it in ${OVERRIDE_PATH}`)
  const { tool, checks = [], command } = action as Record<string, unknown>
  assert(!Array.isArray(action), `a protected action ${pythonText(action)} was read as an object`)
  if (typeof tool !== 'string' || tool === '') throw new PolicyError(`a protected action must name a tool, not ${pythonText(tool)}; set its tool in ${OVERRIDE_PATH}`)
  if (!Array.isArray(checks) || !checks.every(name => typeof name === 'string' && name !== '')) throw new PolicyError(`${tool}'s checks must be an array of check names, not ${pythonText(checks)}; fix them in ${OVERRIDE_PATH}`)
  const pattern = checkedCommand(tool, command)
  assert(Array.isArray(checks), `the protected action of ${tool} was accepted with checks of ${typeof checks}`)
  return { tool, checks: checks as string[], ...(pattern === undefined ? {} : { command: pattern }) }
}

/** The gate of the project's settings, checked in full as the Python engine's read_gate checks it; a PolicyError names the field to fix. */
export function readGate(override: Override): GatePolicy {
  assert(typeof override === 'object' && override !== null, `the settings were read as ${typeof override}, not an object`)
  const policy = 'gate' in override ? override.gate : {}
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) throw new PolicyError(`gate must be an object, not ${pythonText(policy)}; fix it in ${OVERRIDE_PATH}`)
  const { inherited = 'allow', protected_actions: entries = [] } = policy as Record<string, unknown>
  if (!INHERITED_VALUES.includes(inherited as string)) throw new PolicyError(`gate.inherited must be one of ('allow', 'block'), not ${pythonText(inherited)}; fix it in ${OVERRIDE_PATH}`)
  if (!Array.isArray(entries)) throw new PolicyError(`gate.protected_actions must be an array, not ${pythonText(entries)}; fix it in ${OVERRIDE_PATH}`)
  const gate: GatePolicy = { inherited: inherited as 'allow' | 'block', protected_actions: entries.map(checkedAction) }
  assert(Array.isArray(gate.protected_actions) && gate.protected_actions.length === entries.length, `the gate kept ${gate.protected_actions?.length} of ${entries.length} protected actions`)
  return gate
}

/** Undefined means unprotected; an empty list selects every check. The policy is one `readGate` returned, so each of its actions is whole. */
export function protectedChecks(tool: string, input: object, policy: GatePolicy): string[] | undefined {
  assert(typeof tool === 'string', `a tool call named the tool ${typeof tool}, not text`)
  const command = commandOf(input)
  const names = new Set<string>()
  let matched = false
  for (const action of policy.protected_actions ?? []) {
    if (action.tool.toLowerCase() !== tool.toLowerCase()) continue
    if (action.command !== undefined && !patternOf(action.command).test(command)) continue
    matched = true
    if (!action.checks?.length) return []
    for (const name of action.checks) names.add(name)
  }
  assert(matched || names.size === 0, `no action protects ${tool} yet it selected checks ${[...names]}; select only from matching actions`)
  return matched ? [...names] : undefined
}
