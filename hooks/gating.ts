import { assert } from './assert'

/** Only explicitly protected actions are subject to a pre-tool failure gate. */
export type GatePolicy = {
  inherited?: 'allow' | 'block'
  protected_actions?: { tool: string; command?: string; checks?: string[] }[]
}

/** The shell command a tool call runs, from its command or cmd argument; empty when it has neither. */
export function commandOf(input: object): string {
  const arguments_ = input as Record<string, unknown>
  const command = String(arguments_.command ?? arguments_.cmd ?? '')
  assert(typeof command === 'string', `a tool call's command read as ${typeof command}; read it as text`)
  assert(arguments_.command !== undefined || arguments_.cmd !== undefined || command === '', `a tool call with no command gave ${JSON.stringify(command)}; give none as empty text`)
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
  assert(!word.includes("'") || result.length < word.length, `${JSON.stringify(word)} has quotes but unquoted left ${JSON.stringify(result)}; remove them`)
  assert(result === word || /[\\'"]/.test(word), `${JSON.stringify(word)} changed to ${JSON.stringify(result)} with nothing to unquote`)
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
  assert(found === undefined || baseName(words[0]) === 'gh', `found ${found} in ${JSON.stringify(words)}, which do not run gh`)
  assert(found === undefined || found.split(' ').length <= 2, `${found} names more than two words`)
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

/** Undefined means unprotected; an empty list selects every check. */
export function protectedChecks(tool: string, input: object, policy: GatePolicy): string[] | undefined {
  const command = commandOf(input)
  const names = new Set<string>()
  let matched = false
  for (const action of policy.protected_actions ?? []) {
    if (action.tool.toLowerCase() !== tool.toLowerCase()) continue
    if (action.command !== undefined && !new RegExp(action.command).test(command)) continue
    matched = true
    if (!action.checks?.length) return []
    for (const name of action.checks) names.add(name)
  }
  assert(matched || names.size === 0, `no action protects ${tool} yet it selected checks ${[...names]}; select only from matching actions`)
  assert([...names].every(name => name !== ''), `${tool} selected an unnamed check from ${[...names]}; name each check in .overwatch.json`)
  return matched ? [...names] : undefined
}
