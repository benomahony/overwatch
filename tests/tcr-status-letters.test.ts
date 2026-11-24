import { expect } from 'claude-code/testing'
import { namesInStatus } from '../hooks/tcr'
import { longTest } from './fixtures/tcr-session'

longTest('the names of the files that git lists are their paths alone: the letters that tell an untracked file from a tracked one are dropped', () => {
  expect(namesInStatus('?? out.log\0 M src/app.py\0A  new.py\0')).toEqual(['out.log', 'src/app.py', 'new.py'])
})

longTest('a rename or a copy names both of its paths, and the path it came from is read as a path, not as a record with letters', () => {
  expect(namesInStatus('R  new.py\0old.py\0 M a.py\0')).toEqual(['new.py', 'old.py', 'a.py'])
  expect(namesInStatus('C  copy.py\0source.py\0?? b.py\0')).toEqual(['copy.py', 'source.py', 'b.py'])
  expect(namesInStatus(' R moved.py\0before.py\0')).toEqual(['moved.py', 'before.py'])
  expect(namesInStatus('RM staged.py\0original.py\0')).toEqual(['staged.py', 'original.py'])
})
