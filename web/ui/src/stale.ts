// How the run page marks git facts (file counts, Red tests commit, PR state) that come from the server's cache.
/** '' when the facts are fresh (just read, or under 10 s old); otherwise "as of 42 s ago" or "as of 3 min ago". */
export function staleLabel(ageMs: number | null | undefined): string {
  if (ageMs === null || ageMs === undefined || ageMs < 10_000) return '';
  const s = Math.round(ageMs / 1000);
  return s < 90 ? `as of ${s} s ago` : s < 5400 ? `as of ${Math.round(s / 60)} min ago` : `as of ${Math.round(s / 3600)} h ago`;
}
