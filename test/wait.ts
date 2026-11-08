/** Polls <cond> until it holds (a long cap, so a loaded machine only slows the test; a hang still fails). */
export async function eventually(cond: () => boolean, ms = 30_000, step = 20): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the condition');
    await new Promise(r => setTimeout(r, step));
  }
}
