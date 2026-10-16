interface Tab {
  name: string;
  rows: string[][];
}

type Value = number | string | { range: string[] };

class Unsupported extends Error {}

const column = (letters: string) =>
  [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function numeric(value: string) {
  const text = value
    .trim()
    .replace(/^[€$£]\s*|\s*[€$£]$/g, '')
    .replace(/,(?=\d{3}(?!\d))/g, '');
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text) ? Number(text) : undefined;
}

function show(value: number) {
  return String(Math.round(value * 1e9) / 1e9);
}

function wildcard(pattern: string) {
  return new RegExp(
    `^${pattern
      .trim()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i',
  );
}

function matches(cell: string, criterion: Value) {
  if (typeof criterion === 'object') throw new Unsupported();
  const [, op = '=', operand = ''] = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(String(criterion)) ?? [];
  const a = numeric(cell);
  const b = numeric(operand);
  if (a !== undefined && b !== undefined) {
    if (op === '<') return a < b;
    if (op === '>') return a > b;
    if (op === '<=') return a <= b;
    if (op === '>=') return a >= b;
    return op === '<>' ? a !== b : a === b;
  }
  if (op !== '=' && op !== '<>') return false;
  const equal = wildcard(operand).test(cell.trim());
  return op === '=' ? equal : !equal;
}

const tokenPattern =
  /\s*(?:("(?:[^"]|"")*")|((?:'[^']+'|[A-Za-z0-9_]+)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d*)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}\$?\d*)(?![\w(])|(\d+(?:\.\d+)?)|([A-Za-z][A-Za-z0-9.]*)\s*\(|(<=|>=|<>|[-+*/^&=<>(),;]))/y;

export function computeTab(tabs: Tab[], name: string): string[][] {
  const tab = tabs.find((item) => item.name === name);
  if (!tab) return [];
  return tab.rows.map((row, r) => row.map((_, c) => cell(tabs, tab, r, c, new Set())));
}

function cell(tabs: Tab[], tab: Tab, row: number, col: number, seen: Set<string>): string {
  const raw = tab.rows[row]?.[col] ?? '';
  if (!raw.startsWith('=')) return raw;
  const key = `${tab.name}!${row}:${col}`;
  if (seen.has(key)) return '#REF!';
  try {
    const value = evaluate(tabs, tab, raw.slice(1), new Set([...seen, key]));
    if (typeof value === 'object') throw new Unsupported();
    return typeof value === 'number' ? show(value) : value;
  } catch (error) {
    if (error instanceof Unsupported) return raw;
    throw error;
  }
}

function evaluate(tabs: Tab[], home: Tab, formula: string, seen: Set<string>): Value {
  const tokens: Array<{ kind: string; text: string; sheet?: string }> = [];
  tokenPattern.lastIndex = 0;
  while (tokenPattern.lastIndex < formula.length) {
    const start = tokenPattern.lastIndex;
    const match = tokenPattern.exec(formula);
    if (!match || match.index !== start) {
      if (!formula.slice(start).trim()) break;
      throw new Unsupported();
    }
    if (match[1]) tokens.push({ kind: 'string', text: match[1].slice(1, -1).replace(/""/g, '"') });
    else if (match[3])
      tokens.push({
        kind: 'ref',
        text: match[3],
        sheet: match[2]?.slice(0, -1).replace(/^'|'$/g, ''),
      });
    else if (match[4]) tokens.push({ kind: 'number', text: match[4] });
    else if (match[5]) tokens.push({ kind: 'call', text: match[5].toUpperCase() });
    else if (match[6]) tokens.push({ kind: 'op', text: match[6] });
  }
  let index = 0;
  const peek = () => tokens[index];
  const take = (text?: string) => {
    const token = tokens[index++];
    if (!token || (text !== undefined && token.text !== text)) throw new Unsupported();
    return token;
  };
  const scalar = (value: Value) => {
    if (typeof value !== 'object') return value;
    if (value.range.length !== 1) throw new Unsupported();
    return numeric(value.range[0]) ?? value.range[0];
  };
  const number = (value: Value) => {
    const item = scalar(value);
    if (typeof item === 'number') return item;
    if (item.trim() === '') return 0;
    const parsed = numeric(item);
    if (parsed === undefined) throw new Unsupported();
    return parsed;
  };
  const cells = (value: Value) => (typeof value === 'object' ? value.range : [String(value)]);
  const reference = (text: string, sheet?: string): Value => {
    const tab = sheet ? tabs.find((item) => item.name === sheet) : home;
    if (!tab) throw new Unsupported();
    const [from, to = from] = text.replace(/\$/g, '').split(':');
    const point = (part: string, fallback: number) => {
      const found = /^([A-Za-z]+)(\d+)?$/.exec(part)!;
      return { col: column(found[1]), row: found[2] ? Number(found[2]) - 1 : fallback };
    };
    const a = point(from, 0);
    const b = point(to, Math.max(0, tab.rows.length - 1));
    const values: string[] = [];
    const top = Math.min(a.row, b.row);
    const bottom = Math.min(Math.max(a.row, b.row), Math.max(top, tab.rows.length - 1));
    for (let r = top; r <= bottom; r++)
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++)
        values.push(cell(tabs, tab, r, c, seen));
    return text.includes(':') ? { range: values } : (numeric(values[0]) ?? values[0]);
  };
  const call = (name: string, args: Value[]): Value => {
    const all = () => args.flatMap(cells);
    const numbers = () =>
      args.flatMap((arg) =>
        typeof arg === 'object'
          ? arg.range.map(numeric).filter((value): value is number => value !== undefined)
          : [number(arg)],
      );
    const pairs = (from: number) => {
      const groups: Array<[string[], Value]> = [];
      for (let i = from; i < args.length; i += 2) groups.push([cells(args[i]), args[i + 1]]);
      return groups;
    };
    const selected = (size: number, groups: Array<[string[], Value]>) =>
      Array.from({ length: size }, (_, i) =>
        groups.every(([range, criterion]) => matches(range[i] ?? '', criterion)),
      );
    switch (name) {
      case 'SUM':
        return numbers().reduce((sum, value) => sum + value, 0);
      case 'AVERAGE': {
        const values = numbers();
        if (!values.length) throw new Unsupported();
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      }
      case 'MIN':
        return Math.min(...numbers());
      case 'MAX':
        return Math.max(...numbers());
      case 'COUNT':
        return all().filter((value) => numeric(value) !== undefined).length;
      case 'COUNTA':
        return all().filter((value) => value !== '').length;
      case 'ABS':
        return Math.abs(number(args[0]));
      case 'ROUND': {
        const places = args[1] === undefined ? 0 : number(args[1]);
        return Math.round(number(args[0]) * 10 ** places) / 10 ** places;
      }
      case 'SUMIF': {
        const range = cells(args[0]);
        const sum = args[2] === undefined ? range : cells(args[2]);
        return range.reduce(
          (total, value, i) =>
            matches(value, args[1]) ? total + (numeric(sum[i] ?? '') ?? 0) : total,
          0,
        );
      }
      case 'COUNTIF':
        return cells(args[0]).filter((value) => matches(value, args[1])).length;
      case 'SUMIFS': {
        const sum = cells(args[0]);
        const keep = selected(sum.length, pairs(1));
        return sum.reduce(
          (total, value, i) => (keep[i] ? total + (numeric(value) ?? 0) : total),
          0,
        );
      }
      case 'COUNTIFS': {
        const groups = pairs(0);
        return selected(groups[0]?.[0].length ?? 0, groups).filter(Boolean).length;
      }
      default:
        throw new Unsupported();
    }
  };
  const primary = (): Value => {
    const token = take();
    if (token.kind === 'number') return Number(token.text);
    if (token.kind === 'string') return token.text;
    if (token.kind === 'ref') return reference(token.text, token.sheet);
    if (token.kind === 'call') {
      const args: Value[] = [];
      if (peek()?.text !== ')')
        for (;;) {
          args.push(expression());
          if (peek()?.text === ',' || peek()?.text === ';') take();
          else break;
        }
      take(')');
      return call(token.text, args);
    }
    if (token.text === '(') {
      const value = expression();
      take(')');
      return value;
    }
    if (token.text === '-') return -number(primary());
    if (token.text === '+') return number(primary());
    throw new Unsupported();
  };
  const power = (): Value => {
    let left = primary();
    while (peek()?.text === '^') {
      take();
      left = number(left) ** number(primary());
    }
    return left;
  };
  const term = (): Value => {
    let left = power();
    while (peek()?.text === '*' || peek()?.text === '/') {
      const op = take().text;
      const right = number(power());
      left = op === '*' ? number(left) * right : number(left) / right;
    }
    return left;
  };
  function expression(): Value {
    let left = term();
    while (peek()?.text === '+' || peek()?.text === '-' || peek()?.text === '&') {
      const op = take().text;
      const right = term();
      left =
        op === '&'
          ? `${scalar(left)}${scalar(right)}`
          : op === '+'
            ? number(left) + number(right)
            : number(left) - number(right);
    }
    return left;
  }
  const result = expression();
  if (index !== tokens.length) throw new Unsupported();
  return result;
}
