import { expect, test } from 'claude-code/testing'
import { runShard } from './fixtures/tcr-interleavings'
import { classCount, shardSize } from './fixtures/tcr-counts'

const SHARD = 25
const SHARDS = 30
const SHARD_TIMEOUT_MS = 600_000

test('no checkpoint or revert takes a person\'s file in any sequence without a person\'s write during an editing tool (shard 25 of 30)', { timeoutMs: SHARD_TIMEOUT_MS }, async ($, on) => {
  const found = await runShard({ $, on }, SHARD, SHARDS)
  console.log(`shard ${SHARD}: ${found.sequences} sequences, ${found.blind} with a write while an editing tool ran: ${found.blindExamples.join('; ')}`)
  expect(found.sequences).toBe(shardSize(classCount().sequences, SHARD, SHARDS))
  expect(found.violations.slice(0, 5)).toEqual([])
})
