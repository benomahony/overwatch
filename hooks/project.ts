/**
 * The repository a session watches and the watchers it needs: its root and checked-out commit, read from .git, and
 * the project's .overwatch.json, markers and sub-projects.
 */
import type { EngineInterface, FsEntry } from 'claude-code'
import { assert } from './assert'
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

/** Where `path` lands once its links are followed; the path itself when it cannot be resolved. */
export async function realPath($: EngineInterface, path: string): Promise<string> {
  assert(path !== '', `realPath was given ${JSON.stringify(path)}; pass the directory to resolve`)
  const resolved = await $.fs
    .stat(path, { resolve: true })
    .then(({ realPath }) => realPath ?? path)
    .catch(() => path)
  assert(resolved !== '', `${path} resolved to an empty path; fall back to the path itself`)
  return resolved
}

/** The real path of the git repository holding `dir`, the nearest directory with a `.git`; undefined outside one. */
export async function repositoryOf($: EngineInterface, dir: string): Promise<string | undefined> {
  let at = (await realPath($, dir)).replace(/\/$/, '')
  // Each step drops the last part of the path, so this ends by the root at most.
  while (!(await $.fs.exists(`${at}/.git`))) {
    if (at === '') return undefined
    const parent = at.slice(0, at.lastIndexOf('/'))
    assert(parent.length < at.length, `the parent of ${at} is ${parent}; each step must climb one directory`)
    at = parent
  }
  const root = at === '' ? '/' : at
  assert(root.startsWith('/') || !dir.startsWith('/'), `repository ${root} of ${dir} is not an absolute path`)
  return root
}

/** A commit id as git writes it in .git: forty hex digits, or sixty-four in a SHA-256 repository. */
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * The commit checked out in the repository at root, read from its .git directory: HEAD itself when detached, else
 * the branch it names, loose or packed. Undefined when none can be read, as in a worktree whose .git is a file.
 */
export async function commitOf($: EngineInterface, root: string): Promise<string | undefined> {
  assert(root.startsWith('/'), `commitOf was given ${root}; pass the repository's absolute path`)
  const read = async (name: string) => {
    assert(name !== '' && !name.startsWith('/'), `commitOf read ${JSON.stringify(name)}; name a file inside .git`)
    const text = await $.fs.read(`${root}/.git/${name}`).then(found => found.trim(), () => '')
    assert(text === text.trim(), `${name} read as ${JSON.stringify(text)}, untrimmed; trim what .git holds`)
    return text
  }
  const head = await read('HEAD')
  const ref = /^ref: (\S+)$/.exec(head)?.[1]
  if (ref === undefined) return COMMIT.test(head) ? head : undefined
  const loose = await read(ref)
  const packed = loose === '' ? await read('packed-refs') : ''
  const commit = loose || (packed.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? '')
  assert(loose === '' || commit === loose, `${ref} reads ${loose} but resolved to ${commit}; prefer the loose ref`)
  return COMMIT.test(commit) ? commit : undefined
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
  assert(COMMIT.test(from) && COMMIT.test(to) && from !== to, `isCommitted was asked about ${from}..${to}; pass two different commit ids`)
  const log = await $.fs.read(`${root}/.git/logs/HEAD`).then(found => found, () => '')
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

/** The project's .overwatch.json in cwd, or no override when it has none or it is not JSON. */
export async function readOverride($: EngineInterface, cwd: string): Promise<Override> {
  assert(cwd !== '' && !cwd.endsWith(`/${OVERRIDE_PATH}`), `readOverride was given ${cwd}; pass the project's directory`)
  const override: Override = await $.fs
    .read(`${cwd}/${OVERRIDE_PATH}`)
    .then(text => JSON.parse(text) as Override)
    .catch(() => ({}))
  assert(override !== null && typeof override === 'object', `${cwd}/${OVERRIDE_PATH} holds ${JSON.stringify(override)}, not an object; make it a JSON object`)
  return override
}

/** Whether `marker`, a path, is in `dir`, whose own entries are `names`. */
export async function hasMarker($: EngineInterface, dir: string, names: ReadonlySet<string>, marker: string): Promise<boolean> {
  assert(marker !== '' && !marker.startsWith('/'), `marker ${marker} must be a path relative to ${dir}`)
  const [first = '', ...rest] = marker.split('/')
  const has = names.has(first) && (rest.length === 0 || (await $.fs.exists(`${dir}/${marker}`)))
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
      const entries: readonly FsEntry[] = await $.fs.list(parent === '' ? cwd : `${cwd}/${parent}`).catch(() => [])
      for (const { name, kind } of entries) {
        if (kind === 'dir' && !name.startsWith('.') && !SEARCH.skip.has(name)) level.push(parent === '' ? name : `${parent}/${name}`)
      }
    }
    level.sort()
    for (const dir of level) {
      const entries: readonly FsEntry[] = await $.fs.list(`${cwd}/${dir}`).catch(() => [])
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
    const atRoot = await firstPresent($, alternatives, marker => $.fs.exists(`${cwd}/${marker}`))
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

/** Whether `name` is an executable in a directory on PATH. */
export async function isOnPath($: EngineInterface, name: string): Promise<boolean> {
  assert(name !== '' && !name.includes('/'), `isOnPath was given ${name}; pass an executable's name`)
  const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''
  const dirs = path.split(':').filter(dir => dir !== '')
  for (const dir of dirs) {
    if (await $.fs.exists(`${dir}/${name}`).catch(() => false)) return true
  }
  assert(dirs.every(dir => !dir.includes(':')), `PATH ${path} split into ${dirs}; split it at colons`)
  return false
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
export async function findIn($: EngineInterface, cwd: string): Promise<{ watcher: Watcher; dir: string }[]> {
  const root = await repositoryOf($, cwd)
  if (root === undefined) return []
  const watchers = await findAll($, root)
  const placed = await Promise.all(
    watchers.map(async watcher => ({ watcher, dir: await realPath($, watcher.dir === undefined ? root : `${root}/${watcher.dir}`) })),
  )
  assert(placed.length === watchers.length, `placed ${placed.length} of ${watchers.length} watchers of ${root}`)
  assert(placed.every(({ dir }) => dir !== ''), `a watcher of ${root} has no directory to run in`)
  return placed
}
