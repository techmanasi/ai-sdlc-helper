export interface ArgsSpec {
  commands: string[];
  /** Options that take a value (the next argument). */
  valued?: string[];
  /** Options that stand alone. */
  flags?: string[];
}

/** `--opt=value` as `--opt value` for the valued options (the first "=" splits; the value may hold more). */
export function splitEquals(args: string[], valued: string[]): string[] {
  return args.flatMap(a => {
    const eq = a.indexOf('=');
    return a.startsWith('--') && eq > 2 && valued.includes(a.slice(0, eq)) ? [a.slice(0, eq), a.slice(eq + 1)] : [a];
  });
}

/**
 * What is wrong with a command line, or null: a command or option that arrived as one argument with what follows it
 * (zsh and PowerShell pass an unquoted variable as one word, where bash splits it), an unknown option, a missing or
 * unknown command. The value of a valued option is never checked: a test name or a path may hold spaces.
 */
export function argsProblem(rawArgs: string[], { commands, valued = [], flags = [] }: ArgsSpec): string | null {
  const args = splitEquals(rawArgs, valued);
  const known = new Set([...valued, ...flags]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.includes(args[i - 1])) continue;
    const words = a.trim().split(/\s+/);
    if (words.length > 1 && (commands.includes(words[0]) || known.has(words[0]))) {
      return `"${a}" arrived as one argument, so the shell did not split it (zsh and PowerShell do this with an unquoted variable). `
        + `Pass each word separately: ${words.join(' ')}`;
    }
    if (a.startsWith('--') && !known.has(a)) return `unknown option "${a}"`;
  }
  const cmd = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  if (!cmd) return 'no command given';
  if (!commands.includes(cmd)) return `unknown command "${cmd}" (commands: ${commands.join(', ')})`;
  return null;
}

/** A parsed command line: the words that are not options (command first), option values and flags. */
export interface ParsedArgs {
  positional: string[];
  value(name: string): string | undefined;
  flag(name: string): boolean;
}

export function parseArgs(rawArgs: string[], valued: string[] = []): ParsedArgs {
  const args = splitEquals(rawArgs, valued);
  const valueAt = new Set(valued.map(n => args.indexOf(n)).filter(i => i >= 0).map(i => i + 1));
  return {
    positional: args.filter((a, i) => !a.startsWith('--') && !valueAt.has(i)),
    value: name => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? '') : undefined; },
    flag: name => args.includes(name),
  };
}
