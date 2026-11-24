import { expect, test, type TestBody } from 'claude-code/testing'
import { tcrProject } from './tcr'
import { LONG_TEST_MS, type Project } from './tcr-session'
import { NET_TEST_MS, expectToldOfError, sweep, type Run } from './tcr-net'

/**
 * The class check of the entries the host calls: for each entry, the host throws at each step the plugin makes while the
 * entry and the work it starts run, one run for each step, and in every run nothing but that error goes on, at most once, the
 * agent is told when it does, TCR is paused where it was on, and what the entry guards runs when the gate cannot decide. A
 * notice that does not wake the agent, as one about the gate, is told at the start of the next turn, which an entry that ends a turn plays.
 */
export type Entry = { name: string; options?: Parameters<typeof tcrProject>[1]; prepare?: (project: Project) => void; entry: ($: Parameters<TestBody>[0], project: Project) => Promise<unknown>; steps: number; parts?: number; holds?: (run: Run, isPropagated: boolean) => void }

/** One test for each entry, or for each of its `parts`, in the file that lists them, so that no file outlasts the runner's limit for one and no test takes more than a part of the entry's steps. */
export function sweepEntries(entries: Entry[]) {
  for (const each of entries) {
    const parts = each.parts ?? 1
    for (let index = 0; index < parts; index += 1) {
      const name = parts === 1 ? each.name : `${each.name} (part ${index + 1} of ${parts})`
      test(`${name}: a throw of the host at any step still tells the agent, and a call the gate cannot decide about runs`, { timeoutMs: NET_TEST_MS + LONG_TEST_MS }, async ($, on) => {
        const project = tcrProject(on, each.options)
        await sweep({ $, project, prepare: each.prepare, entry: current => each.entry($, current), share: { index, of: parts }, steps: each.steps }, (run, context) => {
          expectToldOfError(run, context)
          each.holds?.(run, run.unhandled.length + run.awaited.length > 0)
        })
      })
    }
  }
}
