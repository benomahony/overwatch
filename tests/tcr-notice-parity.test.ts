import { expect } from 'claude-code/testing'
import { leftUncommitted } from '../hooks/hold-notices'
import { unrevertedMessage } from '../hooks/revert-notices'
import { shortCommit } from '../hooks/tcr'
import type { Report, Watcher } from '../hooks/watchers'
import { longTest } from './fixtures/tcr-session'

const FAILING_CHECKS = 8
const NAMED_AT_MOST = 5
const SHORT_COMMIT_CHARS = 7
const EMOJI = '\u{1f600}'
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const report: Report = { summary: 'summary', isFailed: true, text: 'took 5ms', failures: [] }
const causeOf = (index: number) => ({ watcher: { name: `check${index}`, marker: 'marker', argv: ['pytest'], dir: 'dir' } as Watcher, report, known: [], log: `/logs/log${index}` })

longTest('a reason that ends in a full stop gets no second one, and one that does not gets one', () => {
  expect(leftUncommitted('a commit hook failed.')).toBe('overwatch: TCR left the latest change uncommitted and unreverted: a commit hook failed.')
  expect(leftUncommitted('a commit hook failed')).toBe('overwatch: TCR left the latest change uncommitted and unreverted: a commit hook failed.')
})

longTest('a revert that failed for many checks names five of them and five logs, as the engine does', () => {
  const causes = Array.from({ length: FAILING_CHECKS }, (_, index) => causeOf(index))
  const text = unrevertedMessage(null, { failed: 'git', files: undefined, causes })
  expect(text).toContain(`and ${FAILING_CHECKS - NAMED_AT_MOST} more`)
  expect(text.match(/\/logs\/log\d/g)?.length).toBe(NAMED_AT_MOST)
})

longTest('a commit is cut to seven characters by code point, so that no pair of surrogates is split', () => {
  const cut = shortCommit(EMOJI.repeat(SHORT_COMMIT_CHARS + 3))
  expect([...cut].length).toBe(SHORT_COMMIT_CHARS)
  expect(LONE_SURROGATE.test(cut)).toBe(false)
  expect(shortCommit('0123456789abcdef')).toBe('0123456')
})
