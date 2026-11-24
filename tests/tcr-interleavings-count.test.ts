import { expect } from 'claude-code/testing'
import { classCount, livenessCounts } from './fixtures/tcr-counts'
import { totals } from './fixtures/tcr-interleavings'
import { longTest } from './fixtures/tcr-session'

longTest('the class check generates as many sequences as its rules count, and as many that hold a write during an editing tool', () => {
  expect(totals().class).toEqual(classCount())
})

longTest('the liveness check generates as many sequences as its rules count, and leaves out exactly those that end an editing tool during a decision, as the independent counter finds them', () => {
  expect(totals().liveness).toEqual(livenessCounts())
})
