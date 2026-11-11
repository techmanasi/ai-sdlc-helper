/** Case-insensitive substring filtering for model dropdowns, over both id and display name. */
export function filterModels<T extends { id: string; name: string }>(models: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter(model => `${model.id}\n${model.name}`.toLowerCase().includes(needle));
}

/** Move a highlighted option by `delta` and wrap at both ends, so ArrowDown on the last row starts again at the top. */
export function nextIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}
