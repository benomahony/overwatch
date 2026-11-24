type Host = { setTimeout: (run: () => void, ms: number) => unknown }

const NO_WAIT_MS = 0

/** Waits one turn of the event loop of the process that runs the tests, which their kit has no type for. */
export function turnOfEventLoop(): Promise<void> {
  return new Promise(resolve => (globalThis as unknown as Host).setTimeout(resolve, NO_WAIT_MS))
}
