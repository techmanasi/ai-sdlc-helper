// The run page's environment rows: [name, value] pairs edited in the "Environment" panel.
export type EnvRow = [string, string];

/** Sets a variable to a value, replacing any row of that name; an empty value removes it. */
export const setEnvValue = (rows: EnvRow[], k: string, val: string): EnvRow[] =>
  val ? [...rows.filter(r => r[0].trim() !== k), [k, val]] : rows.filter(r => r[0].trim() !== k);

/**
 * A quick button: adds a row for the variable with its default value (empty when it has none, for the user to fill
 * in). A row already named k is kept as it is, so a second click adds nothing.
 */
export const addEnvKey = (rows: EnvRow[], k: string, def = ''): EnvRow[] =>
  rows.some(r => r[0].trim() === k) ? rows : [...rows, [k, def]];

/** The quick buttons still to show: those whose variable has no row yet (an empty-valued row counts as present). */
export const quickKeys = (rows: EnvRow[], keys: string[]): string[] =>
  keys.filter(k => !rows.some(r => r[0].trim() === k));

/** The variables a run starts with: named rows with a value. A row still waiting for its value is left out, so a
 * quick button's empty row never sends NAME= (an empty SDLC_BASE, ...). */
export const envVars = (rows: EnvRow[]): Record<string, string> =>
  Object.fromEntries(rows.filter(([k, v]) => k.trim() && v !== '').map(([k, v]) => [k.trim(), v]));
