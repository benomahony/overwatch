/**
 * The repository a session watches and the watchers it needs: its root and checked-out commit, read from .git, and
 * the project's .overwatch.json, markers and sub-projects.
 */
import type { EngineInterface, FsEntry } from 'claude-code'
import { assert } from './assert'
import { COMMAND_LIMITS_MS, CommandError, limitOf, secondsOf } from './tcr'
import { readExpecting } from './command-error'
import {
  CHECKERS,
  LANGUAGES,
  OVERRIDE_PATH,
  SEARCH,
  WATCHERS,
  applyOverride,
  configure,
  languageOf,
  overrideWatcher,
  type Override,
  type Watcher,
} from './watchers'

/** A call of the host on the project's files that outlasted its limit, as a file that never answers, a named pipe, does. */
export class ReadTimeout extends CommandError {}

/** How long after a look for the repository outlasted its limit the next looks fail at once with the same error, in milliseconds. */
export const STALLED_MS = 10_000

/** What `call` gives, or a ReadTimeout when it outlasts the limit of a question to the checkpoint command, so that a file that never answers cannot hold a tool call or a timer for ever. */
export async function within<T>($: EngineInterface, call: () => Promise<T>): Promise<T> {
  assert(typeof call === 'function', `the call on the project's files is ${typeof call}, not a function`)
  const limit = await limitOf($, COMMAND_LIMITS_MS.fingerprint)
  let timer: ReturnType<EngineInterface['clock']['after']> | undefined
  try {
    const stopped = new Promise<never>((_, reject) => {
      timer = $.clock.after(limit, () => reject(new ReadTimeout(`a read of the project's files took longer than ${secondsOf(limit)}s`)))
    })
    return await Promise.race([call(), stopped])
  } finally {
    timer?.cancel()
    assert(limit > 0, `a read of the project's files was bounded by ${limit}ms`)
  }
}

/** What a failed read gives, `fallback`, unless it outlasted its limit, which goes on as the reason the search has no answer. */
function otherwise<T>(fallback: T): (error: unknown) => T {
  return error => {
    assert(typeof fallback !== 'function', `the fallback of a failed read is a ${typeof fallback}; give a value, not a function to call`)
    if (error instanceof ReadTimeout) throw error
    assert(!(error instanceof ReadTimeout), `a read that took longer than its limit was answered with ${String(fallback)}; let it go on`)
    return fallback
  }
}

/** Where `path` lands once its links are followed; the path itself when it cannot be resolved, but not when the read outlasted its limit, which goes on. */
export async function realPath($: EngineInterface, path: string): Promise<string> {
  assert(path !== '', `realPath was given ${JSON.stringify(path)}; pass the directory to resolve`)
  const resolved = await within($, () => $.fs.stat(path, { resolve: true }))
    .then(({ realPath }) => realPath ?? path)
    .catch(otherwise(path))
  assert(resolved !== '', `${path} resolved to an empty path; fall back to the path itself`)
  return resolved
}

/** The real path of the git repository holding `dir`, the nearest directory with a `.git`; undefined outside one. */
export async function repositoryOf($: EngineInterface, dir: string): Promise<string | undefined> {
  assert(typeof dir === 'string', `the repository was asked for ${typeof dir}, not a directory`)
  if (!dir.startsWith('/')) return undefined
  let at = (await realPath($, dir)).replace(/\/$/, '')
  // Each step drops the last part of the path, so this ends by the root at most.
  while (!(await within($, () => $.fs.exists(`${at}/.git`)))) {
    if (at === '') return undefined
    const parent = at.slice(0, at.lastIndexOf('/'))
    assert(parent.length < at.length, `the parent of ${at} is ${parent}; each step must climb one directory`)
    at = parent
  }
  const root = at === '' ? '/' : at
  assert(root.startsWith('/'), `repository ${root} of ${dir} is not an absolute path`)
  return root
}

/** The look for the directory `dir` that last outlasted its limit, and when. */
export type RootStall = { dir: string; at: number; error: ReadTimeout }

/** Where a look remembers its stall, and the session it belongs to when it has one: a look of a session that ended writes nothing into the next session's memory. */
export type StallMemory = { rootStall: RootStall | undefined; epoch?: number }

/** The repository holding `dir`, as `repositoryOf` finds it; a look for `dir` that outlasts its limit is remembered in `memory` until a look succeeds or STALLED_MS pass, and the looks for the same `dir` within that time fail at once with an error that says they were not tried. */
export async function rootOf($: EngineInterface, dir: string, memory: StallMemory): Promise<string | undefined> {
  assert(typeof memory === 'object' && memory !== null, `the look for the repository of ${dir} remembers its stall in ${typeof memory}, not an object`)
  const { rootStall, epoch } = memory
  if (rootStall?.dir === dir && (await $.clock.now()) - rootStall.at < STALLED_MS) {
    throw new ReadTimeout(`${rootStall.error.message}; this look was not tried, because the look for ${dir} before it took that long less than ${secondsOf(STALLED_MS)}s ago`)
  }
  try {
    const root = await repositoryOf($, dir)
    assert(root === undefined || typeof root === 'string', `the repository of ${dir} is ${typeof root}, not a path`)
    if (memory.epoch === epoch) memory.rootStall = undefined
    return root
  } catch (error) {
    const at = error instanceof ReadTimeout ? await $.clock.now() : undefined
    if (at !== undefined && memory.epoch === epoch) memory.rootStall = { dir, at, error: error as ReadTimeout }
    throw error
  }
}

/** A commit id as git writes it in .git: forty hex digits, or sixty-four in a SHA-256 repository. */
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * The commit checked out in the repository at root, read from its .git directory: HEAD itself when detached, else
 * the branch it names, loose or packed. A worktree's or submodule's .git file leads to its own directory, where HEAD is,
 * and a worktree's refs are in the directory its `commondir` names. Undefined when none can be read.
 */
export async function commitOf($: EngineInterface, root: string): Promise<string | undefined> {
  assert(root.startsWith('/'), `commitOf was given ${root}; pass the repository's absolute path`)
  const own = await gitDirectoryOf($, root)
  if (own === undefined) return undefined
  const common = await commonDirectoryOf($, own)
  assert(typeof common === 'string', `the common directory of ${own} is ${typeof common}`)
  const read = async (directory: string, name: string) => {
    assert(typeof directory === 'string', `commitOf read a file in ${typeof directory}, not a directory`)
    assert(typeof name === 'string', `commitOf read a file named ${typeof name}, not text`)
    if (name === '' || name.startsWith('/') || name.split('/').includes('..')) return ''
    return within($, () => $.fs.read(`${directory}/${name}`)).then(found => found.trim(), otherwise(''))
  }
  const head = await read(own, 'HEAD')
  const ref = /^ref: (\S+)$/.exec(head)?.[1]
  if (ref === undefined) return COMMIT.test(head) ? head : undefined
  const loose = await read(common, ref)
  const packed = loose === '' ? await read(common, 'packed-refs') : ''
  const commit = loose || (packed.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? '')
  return COMMIT.test(commit) ? commit : undefined
}

const GITDIR_POINTER = /^gitdir: (.+)$/

/** Where `path` leads from `base`, an absolute directory, with its `.` and `..` steps resolved; undefined when it leads to the filesystem's root. */
function resolvedFrom(base: string, path: string): string | undefined {
  assert(base.startsWith('/'), `${path} was resolved from ${base}; pass an absolute directory`)
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  assert(!parts.includes('..') && !parts.includes('.'), `${path} from ${base} kept a relative step in ${parts}; resolve each one`)
  return parts.length === 0 ? undefined : `/${parts.join('/')}`
}

/** The directory that holds the HEAD of the repository at `root`: its .git, or where the `gitdir:` pointer of a worktree's or submodule's .git file leads; undefined when the pointer leads nowhere a git directory can be. */
async function gitDirectoryOf($: EngineInterface, root: string): Promise<string | undefined> {
  assert(root.startsWith('/'), `gitDirectoryOf was given ${root}; pass the repository's absolute path`)
  const base = root === '/' ? '' : root
  const pointer = await within($, () => $.fs.read(`${base}/.git`)).then(text => GITDIR_POINTER.exec(text.trim())?.[1], otherwise(undefined))
  const directory = pointer === undefined ? `${base}/.git` : resolvedFrom(root, pointer)
  assert(directory === undefined || directory.startsWith('/'), `the git directory of ${root} is ${directory}, not an absolute path`)
  return directory
}

/** The directory where the refs of the repository whose own git directory is `own` live: the one its `commondir` file names, as in a worktree; `own` itself otherwise. */
async function commonDirectoryOf($: EngineInterface, own: string): Promise<string> {
  assert(own.startsWith('/'), `commonDirectoryOf was given ${own}; pass a git directory's absolute path`)
  const pointer = await within($, () => $.fs.read(`${own}/commondir`)).then(text => text.trim(), otherwise(''))
  const common = pointer === '' ? own : (resolvedFrom(own, pointer) ?? own)
  assert(common.startsWith('/'), `the common directory of ${own} is ${common}, not an absolute path`)
  return common
}

/** The branch the repository at `root` has checked out, read from its git directory, which a worktree's or submodule's .git file points to; undefined when HEAD names a commit or cannot be read. */
export async function branchOf($: EngineInterface, root: string): Promise<string | undefined> {
  assert(root.startsWith('/'), `branchOf was given ${root}; pass the repository's absolute path`)
  const directory = await gitDirectoryOf($, root)
  assert(directory === undefined || typeof directory === 'string', `the git directory of ${root} is ${typeof directory}`)
  const head = directory === undefined ? '' : await within($, () => $.fs.read(`${directory}/HEAD`)).then(text => text.trim(), otherwise(''))
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1]
  return branch
}

/** The reflog message of a move that records the workspace without changing it: a commit, or an amended one. */
export const RECORDING = /^commit(?: \(amend\))?: /

/**
 * Whether HEAD went from `from` to `to` by commits alone, as the reflog in .git/logs/HEAD shows: a commit records the
 * workspace without changing it, so it brings in no failure the agent did not make. False when the reflog cannot
 * show every step, as when it is off, or when a pull, checkout or reset came between.
 */
export async function isCommitted($: EngineInterface, root: string, from: string, to: string): Promise<boolean> {
  assert(root.startsWith('/'), `isCommitted was given ${root}; pass the repository's absolute path`)
  const directory = await gitDirectoryOf($, root)
  const log = directory === undefined ? '' : await within($, () => $.fs.read(`${directory}/logs/HEAD`)).then(found => found, otherwise(''))
  const steps = log.trimEnd().split('\n').reverse().map(line => /^(\S+) (\S+) [^\t]*\t(.*)$/.exec(line))
  let at = to
  let isReached = false
  for (const step of steps) {
    if (step === null || step[2] !== at || !RECORDING.test(step[3]!)) break
    at = step[1]!
    isReached = at === from
    if (isReached) break
  }
  assert(!isReached || at === from, `isCommitted reached ${at}, not ${from}; follow the reflog back to the old HEAD`)
  return isReached
}

/** What the project's .overwatch.json in cwd holds as JSON, or an empty object when it has none or it is not JSON. A file that is there and cannot be read, or that never answers, is a CommandError: it is no file that is missing. */
export async function readSettings($: EngineInterface, cwd: string): Promise<unknown> {
  assert(typeof cwd === 'string' && cwd !== '', `readSettings was given ${JSON.stringify(cwd)}; pass the project's directory`)
  const path = `${cwd}/${OVERRIDE_PATH}`
  assert(path.length > cwd.length, `the settings file ${path} is not inside ${cwd}`)
  const text = await within($, () => $.fs.read(path)).catch(async (error: unknown) => {
    if (error instanceof ReadTimeout) throw error
    if (await within($, () => $.fs.exists(path)).catch(otherwise(false))) throw new CommandError(`${OVERRIDE_PATH} exists and could not be read: ${String(error)}`)
    return undefined
  })
  return text === undefined ? {} : parsedOrEmpty(text, path)
}

/** What the text of a settings file holds as JSON, or an empty object when it is not JSON. */
function parsedOrEmpty(text: string, path: string): unknown {
  assert(typeof text === 'string', `${path} was read as ${typeof text}, not text`)
  try {
    const settings: unknown = JSON.parse(text)
    assert(settings !== undefined, `${path} parsed to nothing; JSON always holds a value`)
    return settings
  } catch {
    return {}
  }
}

/** Whether what a settings file holds is a JSON object, which is all an override can be. */
export function isOverride(settings: unknown): settings is Override {
  assert(settings !== undefined, `a settings file read as ${String(settings)}; JSON holds a value, never undefined`)
  assert(['object', 'string', 'number', 'boolean'].includes(typeof settings), `a settings file read as ${typeof settings}: ${String(settings)}, which JSON never holds`)
  return typeof settings === 'object' && settings !== null && !Array.isArray(settings)
}

/** The project's .overwatch.json in cwd, or no override when it has none, it is not JSON or it holds no object. */
export async function readOverride($: EngineInterface, cwd: string): Promise<Override> {
  assert(typeof cwd === 'string' && cwd !== '', `readOverride was given ${JSON.stringify(cwd)}; pass the project's directory`)
  const settings = await readSettings($, cwd)
  const override = isOverride(settings) ? settings : {}
  assert(isOverride(override), `${cwd}/${OVERRIDE_PATH} gave ${JSON.stringify(override)}, not an object`)
  return override
}

/** Whether `marker`, a path, is in `dir`, whose own entries are `names`. */
export async function hasMarker($: EngineInterface, dir: string, names: ReadonlySet<string>, marker: string): Promise<boolean> {
  assert(marker !== '' && !marker.startsWith('/'), `marker ${marker} must be a path relative to ${dir}`)
  const [first = '', ...rest] = marker.split('/')
  const has = names.has(first) && (rest.length === 0 || (await within($, () => $.fs.exists(`${dir}/${marker}`))))
  assert(!has || names.has(first), `${dir} has marker ${marker} without its first part ${first}`)
  return has
}

/** A directory below the project's root, relative to it, and its entries' names. */
export type Subproject = { dir: string; names: ReadonlySet<string> }

/** The directories SEARCH.depth levels down, nearest and then alphabetically first, leaving out hidden and SEARCH.skip ones. */
export async function findSubprojects($: EngineInterface, cwd: string): Promise<Subproject[]> {
  const found: Subproject[] = []
  let parents = ['']
  for (let depth = 0; depth < SEARCH.depth && parents.length > 0; depth += 1) {
    const level: string[] = []
    for (const parent of parents) {
      const entries: readonly FsEntry[] = await within($, () => $.fs.list(parent === '' ? cwd : `${cwd}/${parent}`)).catch(otherwise([]))
      for (const { name, kind } of entries) {
        if (kind === 'dir' && !name.startsWith('.') && !SEARCH.skip.has(name)) level.push(parent === '' ? name : `${parent}/${name}`)
      }
    }
    level.sort()
    for (const dir of level) {
      const entries: readonly FsEntry[] = await within($, () => $.fs.list(`${cwd}/${dir}`)).catch(otherwise([]))
      found.push({ dir, names: new Set(entries.map(({ name }) => name)) })
    }
    parents = level
  }
  assert(new Set(found.map(({ dir }) => dir)).size === found.length, `subprojects of ${cwd} repeat a directory; list each parent once`)
  assert(found.every(({ dir }) => dir.split('/').length <= SEARCH.depth), `subprojects of ${cwd} go past ${SEARCH.depth} levels; stop at SEARCH.depth`)
  return found
}

/** The first of a language's alternatives whose marker `has` finds and whose tool, if it needs one, is on PATH. */
export async function firstPresent($: EngineInterface, alternatives: readonly Watcher[], has: (marker: string) => Promise<boolean>) {
  assert(new Set(alternatives.map(languageOf)).size <= 1, `alternatives ${alternatives.map(({ name }) => name)} span languages; pass one language's`)
  for (const watcher of alternatives) {
    if (!(await has(watcher.marker))) continue
    if (watcher.requires === undefined || (await isOnPath($, watcher.requires))) return watcher
  }
  assert(alternatives.length > 0 || LANGUAGES.length === 0, `firstPresent was given ${alternatives.length} alternatives of ${LANGUAGES.length} languages; pass a language from LANGUAGES`)
  return undefined
}

/**
 * The project's test watchers, one for each language it has: the first of
 * that language's whose marker, and tool if it needs one, are present. A
 * language the root lacks is looked for in each sub-project, one not inside
 * another that has it. The override applies to the first watcher found; with
 * none, it is the watcher.
 */
export async function findWatchers($: EngineInterface, cwd: string, override: Override): Promise<Watcher[]> {
  const found: Watcher[] = []
  let subprojects: Subproject[] | undefined
  for (const language of LANGUAGES) {
    const alternatives = WATCHERS.filter(watcher => languageOf(watcher) === language)
      .flatMap(watcher => configure(watcher, watcher.name, override) ?? [])
    const atRoot = await firstPresent($, alternatives, marker => within($, () => $.fs.exists(`${cwd}/${marker}`)))
    if (atRoot !== undefined) {
      found.push(atRoot)
      continue
    }
    subprojects ??= await findSubprojects($, cwd)
    const claimed: string[] = []
    for (const { dir, names } of subprojects) {
      if (claimed.some(parent => dir.startsWith(`${parent}/`))) continue
      const watcher = await firstPresent($, alternatives, marker => hasMarker($, `${cwd}/${dir}`, names, marker))
      if (watcher === undefined) continue
      claimed.push(dir)
      found.push({ ...watcher, language, name: `${watcher.name} ${dir}`, dir })
    }
  }
  const [first, ...rest] = found
  assert(new Set(found.map(({ name }) => name)).size === found.length, `watchers ${found.map(({ name }) => name)} repeat a name; find each language once per directory`)
  if (first !== undefined) return [applyOverride(first, override), ...rest]
  const project = overrideWatcher(override)
  assert(project === undefined || project.marker === OVERRIDE_PATH, `the override watcher ${project?.name} is not marked by ${OVERRIDE_PATH}`)
  return project === undefined ? [] : [project]
}

/** Where the executable `name` is in the first directory on PATH that has it; undefined when none does. */
export async function onPath($: EngineInterface, name: string): Promise<string | undefined> {
  assert(name !== '' && !name.includes('/'), `onPath was given ${name}; pass an executable's name`)
  const path = (await readExpecting(() => $.env.get('PATH'))).value ?? ''
  const dirs = path.split(':').filter(dir => dir !== '')
  for (const dir of dirs) {
    if (await within($, () => $.fs.exists(`${dir}/${name}`)).catch(otherwise(false))) return `${dir}/${name}`
  }
  assert(dirs.every(dir => !dir.includes(':')), `PATH ${path} split into ${dirs}; split it at colons`)
  return undefined
}

/** Whether `name` is an executable in a directory on PATH. */
export async function isOnPath($: EngineInterface, name: string): Promise<boolean> {
  assert(name !== '' && !name.includes('/'), `isOnPath was given ${name}; pass an executable's name`)
  const found = await onPath($, name)
  assert(found === undefined || found.endsWith(`/${name}`), `${name} was found on PATH as ${found}; give the path in its directory`)
  return found !== undefined
}

/** Every watcher the project has, read afresh, then each checker installed; none while overwatch is off. */
export async function findAll($: EngineInterface, cwd: string): Promise<Watcher[]> {
  const override = await readOverride($, cwd)
  if (override.enabled === false) return []
  const checkers: Watcher[] = []
  for (const checker of CHECKERS) {
    const configured = configure(checker, checker.name, override)
    if (configured !== undefined && (await isOnPath($, checker.marker))) checkers.push(configured)
  }
  const watchers = await findWatchers($, cwd, override)
  assert(checkers.every(checker => CHECKERS.some(({ name }) => name === checker.name)), `checkers ${checkers.map(({ name }) => name)} are not all from CHECKERS`)
  assert(checkers.length <= CHECKERS.length, `found ${checkers.length} of ${CHECKERS.length} checkers; add each once`)
  return [...watchers, ...checkers]
}

/** The watchers of the git repository holding `cwd`, each with the real path it runs in; none outside a repository. */
export async function findIn($: EngineInterface, cwd: string, memory: StallMemory): Promise<{ watcher: Watcher; dir: string }[]> {
  const root = await rootOf($, cwd, memory)
  if (root === undefined) return []
  const watchers = await findAll($, root)
  const placed = await Promise.all(
    watchers.map(async watcher => ({ watcher, dir: await realPath($, watcher.dir === undefined ? root : `${root}/${watcher.dir}`) })),
  )
  assert(placed.length === watchers.length, `placed ${placed.length} of ${watchers.length} watchers of ${root}`)
  assert(placed.every(({ dir }) => dir !== ''), `a watcher of ${root} has no directory to run in`)
  return placed
}
