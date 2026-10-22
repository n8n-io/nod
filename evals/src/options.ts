const booleans = new Set([
  'resume',
  'ignore-window',
  'include-pending',
  'fix',
  'no-diagnose',
  'no-canary',
  'enforce',
  'open',
  'desktop',
  'markdown',
  'json',
  'help',
]);

export interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const [name, inline] = item.slice(2).split(/=(.*)/s);
    if (inline !== undefined) flags.set(name, inline);
    else if (booleans.has(name)) flags.set(name, true);
    else if (argv[index + 1] === undefined || argv[index + 1].startsWith('--'))
      throw new Error(`--${name} needs a value.`);
    else flags.set(name, argv[++index]);
  }
  const [command = 'help', ...rest] = positional;
  return { command: flags.has('help') ? 'help' : command, positional: rest, flags };
}

export const text = (args: Args, name: string) => {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};
export const has = (args: Args, name: string) => args.flags.has(name);
export const whole = (args: Args, name: string, fallback: number) => {
  const value = text(args, name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`--${name} must be a positive whole number.`);
  return number;
};

export const number = (args: Args, name: string, minimum: number, maximum = Infinity) => {
  const value = text(args, name);
  if (value === undefined) return undefined;
  const parsed = value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(
      `--${name} must be a number from ${minimum}${maximum === Infinity ? ' up' : ` to ${maximum}`}.`,
    );
  return parsed;
};
export const choice = <T extends string>(
  args: Args,
  name: string,
  allowed: readonly T[],
  fallback: T,
) => {
  const value = text(args, name) ?? fallback;
  if (!allowed.includes(value as T))
    throw new Error(`--${name} must be one of: ${allowed.join(', ')}.`);
  return value as T;
};
