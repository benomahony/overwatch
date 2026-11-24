import { expect, test } from 'claude-code/testing'
import { runLivenessShard } from './fixtures/tcr-interleavings'
import { livenessCount, shardSize } from './fixtures/tcr-counts'

const SHARD = 8
const SHARDS = 12
const SHARD_TIMEOUT_MS = 600_000

test('every edit of the agent is committed or reverted in every sequence without a person\'s write (shard 8 of 12)', { timeoutMs: SHARD_TIMEOUT_MS }, async ($, on) => {
  const found = await runLivenessShard({ $, on }, SHARD, SHARDS)
  console.log(`liveness shard ${SHARD}: ${found.sequences} sequences, ${found.limited} with an editing tool ending during a turn start's decision`)
  expect(found.sequences).toBe(shardSize(livenessCount(), SHARD, SHARDS))
  expect(found.violations.slice(0, 5)).toEqual([])
})
