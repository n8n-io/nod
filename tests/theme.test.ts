import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  applyAccountTheme,
  currentTheme,
  initializeTheme,
  setTheme,
  subscribeTheme,
} from '../src/web/lib/theme.ts';

const bootstrap = await readFile(new URL('../public/theme-init.js', import.meta.url), 'utf8');

function page(dark: boolean, saved?: string, blocked = false) {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="theme-color" content="#fefdfc"></head><body></body></html>',
    {
      url: 'http://localhost:4310/credentials/synthetic',
      runScripts: 'outside-only',
    },
  );
  const listeners = new Set<() => void>();
  const media = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(dom.window, 'matchMedia', { value: () => media });
  if (saved) dom.window.localStorage.setItem('otto.theme', saved);
  if (blocked)
    Object.defineProperty(dom.window, 'localStorage', {
      get() {
        throw new Error('Storage unavailable');
      },
    });
  dom.window.eval(bootstrap);
  return {
    dom,
    media,
    change: (value: boolean) => {
      media.matches = value;
      for (const listener of listeners) listener();
    },
  };
}

test('theme is selected before app rendering from a saved choice or OS preference', () => {
  for (const [dark, saved, expected, blocked] of [
    [true, undefined, 'dark', false],
    [false, undefined, 'light', false],
    [true, 'light', 'light', false],
    [false, 'dark', 'dark', false],
    [true, 'invalid', 'dark', false],
    [true, 'system', 'dark', false],
    [true, undefined, 'dark', true],
  ] as const) {
    const { dom } = page(dark, saved, blocked);
    assert.equal(dom.window.document.documentElement.dataset.theme, expected);
    assert.equal(dom.window.document.documentElement.style.colorScheme, expected);
    assert.equal(
      dom.window.document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
      expected === 'dark' ? '#1c1c1f' : '#fefdfc',
    );
    dom.window.close();
  }
});

test('theme choice persists, synchronizes tabs and follows OS changes only without a choice', () => {
  const { dom, change } = page(false);
  for (const key of ['window', 'document', 'Event'] as const)
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const dispose = initializeTheme();
  let updates = 0;
  const unsubscribe = subscribeTheme(() => updates++);
  try {
    change(true);
    assert.equal(currentTheme(), 'dark');
    assert.equal(dom.window.localStorage.getItem('otto.theme'), null);
    setTheme('light');
    assert.equal(currentTheme(), 'light');
    assert.equal(dom.window.localStorage.getItem('otto.theme'), 'light');
    change(false);
    change(true);
    assert.equal(currentTheme(), 'light');
    const reopened = page(true, dom.window.localStorage.getItem('otto.theme')!);
    assert.equal(reopened.dom.window.document.documentElement.dataset.theme, 'light');
    reopened.dom.window.close();
    dom.window.localStorage.setItem('otto.theme', 'dark');
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'otto.theme' }));
    assert.equal(currentTheme(), 'dark');
    dom.window.localStorage.removeItem('otto.theme');
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'otto.theme' }));
    change(false);
    assert.equal(currentTheme(), 'light');
    assert.ok(updates >= 4);
    unsubscribe();
    const before = updates;
    setTheme('dark');
    assert.equal(updates, before);
  } finally {
    unsubscribe();
    dispose();
    dom.window.close();
  }
});

test('an explicit theme remains usable for the session when browser storage is denied', () => {
  const { dom, change } = page(false, undefined, true);
  for (const key of ['window', 'document', 'Event'] as const)
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const dispose = initializeTheme();
  try {
    setTheme('dark');
    change(false);
    assert.equal(currentTheme(), 'dark');
  } finally {
    dispose();
    dom.window.close();
  }
});

test('account themes override the device without leaking the choice to another account', () => {
  const { dom, change } = page(false, 'dark');
  for (const key of ['window', 'document', 'Event'] as const)
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const dispose = initializeTheme();
  try {
    applyAccountTheme('light');
    assert.equal(currentTheme(), 'light');
    assert.equal(dom.window.localStorage.getItem('otto.theme'), 'dark');
    change(true);
    assert.equal(currentTheme(), 'light');
    applyAccountTheme('system');
    change(false);
    assert.equal(currentTheme(), 'light');
    change(true);
    assert.equal(currentTheme(), 'dark');
    dom.window.localStorage.setItem('otto.theme', 'light');
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'otto.theme' }));
    assert.equal(currentTheme(), 'dark');
    applyAccountTheme(undefined);
    assert.equal(currentTheme(), 'light');
    setTheme('system');
    assert.equal(currentTheme(), 'dark');
    change(false);
    assert.equal(currentTheme(), 'light');
  } finally {
    dispose();
    dom.window.close();
  }
});

test('light and dark semantic text and button pairs meet normal-text contrast', async () => {
  const css = await readFile(new URL('../src/web/theme.css', import.meta.url), 'utf8');
  const blocks = [...css.matchAll(/:root(?:\[data-theme='dark'\])?\s*\{([^}]+)\}/g)];
  const tokens = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*(#[\da-f]+);/g)].map((match) => [match[1], match[2]]),
    );
  const light = tokens(blocks[0]![1]!);
  const dark = { ...light, ...tokens(blocks[1]![1]!) };
  const luminance = (hex: string) => {
    const value =
      hex.length === 4
        ? hex
            .slice(1)
            .split('')
            .map((part) => part + part)
            .join('')
        : hex.slice(1);
    const [red, green, blue] = [0, 2, 4].map((offset) => {
      const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
  };
  for (const [name, palette] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    for (const foreground of [
      'foreground',
      'text-secondary',
      'muted-foreground',
      'placeholder',
      'link',
    ]) {
      for (const background of [
        'canvas',
        'sidebar',
        'surface',
        'surface-overlay',
        'surface-subtle',
        'surface-inset',
        'secondary',
        'muted',
        'input-background',
      ]) {
        const values = [luminance(palette[foreground]!), luminance(palette[background]!)].sort(
          (a, b) => b - a,
        );
        const ratio = (values[0]! + 0.05) / (values[1]! + 0.05);
        assert.ok(ratio >= 4.5, `${name} ${foreground}/${background}: ${ratio.toFixed(2)}`);
      }
    }
    for (const [foreground, background] of [
      ['primary-foreground', 'primary'],
      ['primary-foreground', 'primary-hover'],
      ['control-foreground', 'control'],
      ['control-foreground', 'control-hover'],
      ['on-solid', 'destructive'],
      ['foreground', 'accent-soft'],
      ['accent', 'accent-soft'],
      ['error', 'error-soft'],
      ['success', 'success-soft'],
      ['warning', 'warning-soft'],
      ['info', 'info-soft'],
    ]) {
      const values = [luminance(palette[foreground!]!), luminance(palette[background!]!)].sort(
        (a, b) => b - a,
      );
      const ratio = (values[0]! + 0.05) / (values[1]! + 0.05);
      assert.ok(ratio >= 4.5, `${name} ${foreground}/${background}: ${ratio.toFixed(2)}`);
    }
    for (const background of [
      'canvas',
      'sidebar',
      'surface',
      'surface-overlay',
      'surface-subtle',
      'surface-inset',
      'secondary',
      'muted',
      'control',
    ]) {
      const values = [luminance(palette.ring!), luminance(palette[background]!)].sort(
        (a, b) => b - a,
      );
      const ratio = (values[0]! + 0.05) / (values[1]! + 0.05);
      assert.ok(ratio >= 3, `${name} ring/${background}: ${ratio.toFixed(2)}`);
    }
  }
  assert.ok(
    luminance(dark['control-border']!) <= luminance(dark.border!),
    'dark control borders must not outline controls brighter than their card',
  );
  for (const [lower, upper] of [
    ['canvas', 'surface'],
    ['surface', 'surface-overlay'],
    ['surface-overlay', 'hover'],
  ])
    assert.ok(luminance(dark[upper]!) > luminance(dark[lower]!), `dark ${upper} above ${lower}`);
});
