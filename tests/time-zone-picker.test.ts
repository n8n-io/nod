import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement, useState } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'NodeFilter',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { TimeZonePicker } = await import('../src/web/components/time-zone-picker.tsx');
const { Dialog, DialogContent, DialogTitle } = await import('../src/web/components/ui.tsx');
const zones = ['America/Los_Angeles', 'America/New_York', 'Europe/Lisbon', 'Europe/London', 'UTC'];

async function mountPicker() {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const selected: string[] = [];
  let submits = 0;
  function Fixture() {
    const [open, setOpen] = useState(true);
    const [value, setValue] = useState('Europe/Lisbon');
    return createElement(
      Dialog,
      { open, onOpenChange: setOpen },
      createElement(
        DialogContent,
        { 'aria-describedby': undefined },
        createElement(DialogTitle, {}, 'Settings'),
        createElement(
          'form',
          {
            onSubmit(event) {
              event.preventDefault();
              submits++;
            },
          },
          createElement('button', { type: 'button', id: 'before-time-zone' }, 'Previous field'),
          createElement('span', { id: 'time-zone-label' }, 'Time zone'),
          createElement(TimeZonePicker, {
            value,
            zones,
            labelledBy: 'time-zone-label',
            onChange(zone) {
              selected.push(zone);
              setValue(zone);
            },
          }),
          createElement('button', { type: 'button', id: 'after-time-zone' }, 'Next field'),
          createElement('button', { type: 'submit' }, 'Save changes'),
        ),
      ),
    );
  }
  await act(async () => root.render(createElement(Fixture)));
  const trigger = document.querySelector<HTMLButtonElement>('.time-zone-picker-trigger')!;
  const open = async () => act(async () => trigger.click());
  const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input(),
        value,
      );
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const press = async (key: string, options: KeyboardEventInit = {}) => {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }),
      );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  };
  const active = () => document.getElementById(input().getAttribute('aria-activedescendant')!);
  const close = async () => {
    await act(async () => root.unmount());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    element.remove();
  };
  return { trigger, open, input, type, press, active, close, selected, submits: () => submits };
}

test('time zone search accepts cities, spaces, underscores and regions without submitting the form', async () => {
  const picker = await mountPicker();
  try {
    await picker.open();
    assert.equal(document.activeElement, picker.input());
    assert.ok(picker.input().matches('.search-field > .input'));
    assert.ok(document.querySelector('.time-zone-picker-panel')?.classList.contains('menu'));
    assert.ok(picker.active()?.classList.contains('menu-item'));
    assert.equal(picker.active()?.textContent, 'Europe/Lisbon');
    assert.equal(picker.active()?.getAttribute('aria-selected'), 'true');
    for (const query of ['new york', 'america/new_york', 'america new york']) {
      await picker.type(query);
      assert.equal(document.querySelectorAll('[role="option"]').length, 1);
      assert.equal(picker.active()?.textContent, 'America/New York');
    }
    await picker.press('Enter', { isComposing: true });
    assert.deepEqual(picker.selected, []);
    await picker.press('Enter');
    assert.deepEqual(picker.selected, ['America/New_York']);
    assert.equal(picker.submits(), 0);
    assert.equal(document.querySelector('[role="combobox"]'), null);
    assert.equal(document.activeElement, picker.trigger);
    assert.equal(picker.trigger.textContent, 'America/New York');
    await picker.open();
    assert.equal(picker.input().value, '');
    assert.equal(picker.active()?.getAttribute('aria-selected'), 'true');
    await picker.type('europe/lísbon');
    assert.equal(picker.active()?.textContent, 'Europe/Lisbon');
  } finally {
    await picker.close();
  }
});

test('time zone keyboard navigation wraps and search can recover from no results', async () => {
  const picker = await mountPicker();
  try {
    picker.trigger.focus();
    await picker.press('ArrowDown');
    await picker.press('Home');
    assert.equal(picker.active()?.textContent, 'America/Los Angeles');
    await picker.press('End');
    assert.equal(picker.active()?.textContent, 'UTC');
    await picker.press('ArrowDown');
    assert.equal(picker.active()?.textContent, 'America/Los Angeles');
    await picker.press('ArrowUp');
    assert.equal(picker.active()?.textContent, 'UTC');
    await picker.type('Atlantis');
    assert.equal(document.querySelectorAll('[role="option"]').length, 0);
    assert.equal(picker.input().hasAttribute('aria-activedescendant'), false);
    assert.equal(document.querySelector('[role="status"]')?.textContent, 'No time zones found.');
    await picker.press('ArrowDown');
    await picker.press('Enter');
    assert.deepEqual(picker.selected, []);
    assert.equal(picker.submits(), 0);
    assert.ok(picker.input());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Clear time zone search"]')!.click(),
    );
    assert.equal(document.activeElement, picker.input());
    assert.equal(document.querySelectorAll('[role="option"]').length, zones.length);
    assert.equal(picker.active()?.textContent, 'Europe/Lisbon');
    assert.equal(document.querySelector('[role="status"]'), null);
  } finally {
    await picker.close();
  }
});

test('time zone Escape closes only the picker and Tab continues through Settings', async () => {
  const picker = await mountPicker();
  try {
    await picker.open();
    await picker.press('Escape');
    assert.equal(document.querySelector('[aria-label="Choose time zone"]'), null);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(document.activeElement, picker.trigger);
    await picker.open();
    await picker.press('Tab');
    assert.equal(document.querySelector('[role="combobox"]'), null);
    assert.equal(document.activeElement?.id, 'after-time-zone');
    await picker.open();
    await picker.press('Tab', { shiftKey: true });
    assert.equal(document.querySelector('[role="combobox"]'), null);
    assert.equal(document.activeElement?.id, 'before-time-zone');
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    await picker.press('Escape');
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await picker.close();
  }
});
