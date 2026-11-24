/**
 * The failures the plugin expects of what it asks: the checkpoint command could not answer or refused, or the host
 * refused a read. Any other failure is a bug of the plugin and goes on.
 */
import { assert } from './assert'

const NO_REASON = 'the checkpoint command failed and gave no reason'

/** The checkpoint command could not answer, or refused; the message says why. `answer` is the object it printed with its failure, when it printed one. */
export class CommandError extends Error {
  readonly answer: Record<string, unknown> | undefined

  constructor(message: string, answer?: Record<string, unknown>) {
    assert(typeof message === 'string', `the checkpoint command failed with a message of ${typeof message}, not text`)
    assert(answer === undefined || typeof answer === 'object', `the answer that came with the failure is ${typeof answer}, not an object`)
    super(message === '' ? NO_REASON : message)
    this.answer = answer
  }
}

/** The name the error of the host carries when it refuses a call or has none to answer it, as the host answers a read of an environment variable it refuses or does not hold. */
const HOST_REFUSAL = 'HooksError'

/** What `attempt` gives, or the message of the failure when it failed as a CommandError or as a refusal of the host, which are expected failures. Any other failure goes on. */
export async function readExpecting<T>(attempt: () => Promise<T>): Promise<{ value: T | undefined; failure: string | undefined }> {
  assert(typeof attempt === 'function', `the read is ${typeof attempt}, not a function`)
  const outcome = await attempt().then(
    (value): { value: T | undefined; failure: string | undefined } => ({ value, failure: undefined }),
    (error: unknown) => {
      if (error instanceof CommandError) return { value: undefined, failure: error.message }
      if (error instanceof Error && error.name === HOST_REFUSAL) return { value: undefined, failure: error.message }
      throw error
    },
  )
  assert(outcome.failure === undefined || outcome.value === undefined, `a read that failed with ${outcome.failure} also gave ${String(outcome.value)}`)
  return outcome
}
