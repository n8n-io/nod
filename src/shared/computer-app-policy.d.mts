export function appKey(id: string): string;
export function computerAppRule(
  id: string,
  keptOut?: string[],
): { kind: 'blocked' | 'view'; why: string } | { kind: 'use'; why?: undefined };
export function systemShortcut(keys: string, platform?: string): boolean;
