/** Throws message when condition fails; a hooks module has no Node, so no node:assert. */
export function assert(condition: unknown, message: string): asserts condition { // zanity: ignore[assertion-density]
  if (!condition) throw new Error(message)
}
