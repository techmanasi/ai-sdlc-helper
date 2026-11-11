/** Case-insensitive substring filtering for model dropdowns, over both id and display name. */
export function filterModels<T extends { id: string; name: string }>(models: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter(model => `${model.id}\n${model.name}`.toLowerCase().includes(needle));
}
