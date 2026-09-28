/** Host callbacks must not interrupt engine notifications or resource teardown. */
export function runSafely(callback: () => void, context: string): void {
  try {
    callback();
  } catch (error) {
    console.warn(`[RageLayer] ${context}`, error);
  }
}
