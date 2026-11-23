import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function withBuggyEngine(eventName, run) {
  assert(typeof eventName === 'string' && eventName !== '', `event name ${JSON.stringify(eventName)}; pass the hook event the bug fires on`)
  assert(typeof run === 'function', `run is ${typeof run}; pass a function of the project directory`)
  const directory = mkdtempSync(join(tmpdir(), 'overwatch-bug-'))
  const sitecustomize = [
    'import json',
    'loads = json.loads',
    'def broken(text, *arguments, **options):',
    `    if "${eventName}" in str(text):`,
    '        raise AttributeError("probe bug")',
    '    return loads(text, *arguments, **options)',
    'json.loads = broken',
    '',
  ].join('\n')
  writeFileSync(join(directory, 'sitecustomize.py'), sitecustomize)
  const restore = pointPythonAt(directory)
  return Promise.resolve(run(directory)).finally(restore)
}

function pointPythonAt(directory) {
  assert(typeof directory === 'string' && directory !== '', `directory ${JSON.stringify(directory)}; pass the directory that holds sitecustomize.py`)
  const saved = process.env.PYTHONPATH
  process.env.PYTHONPATH = directory
  return () => {
    assert(process.env.PYTHONPATH === directory, `PYTHONPATH is ${process.env.PYTHONPATH}, not the ${directory} this set; nothing else may change it meanwhile`)
    if (saved === undefined) delete process.env.PYTHONPATH
    else process.env.PYTHONPATH = saved
  }
}
