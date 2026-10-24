import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from './icons';
import { SearchField } from './ui';

function searchText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_/]+/g, ' ')
    .toLowerCase();
}

export interface PickerOption {
  value: string;
  label: string;
  keywords?: string;
}

const timeZoneLabels = {
  choose: 'Choose time zone',
  search: 'Search time zones',
  placeholder: 'Search city or time zone',
  clear: 'Clear time zone search',
  list: 'Time zones',
  empty: 'No time zones found.',
};

export function TimeZonePicker({
  zones,
  ...props
}: {
  value: string;
  zones: string[];
  disabled?: boolean;
  labelledBy: string;
  onChange(value: string): void;
}) {
  return (
    <SearchPicker
      {...props}
      options={zones.map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }))}
      labels={timeZoneLabels}
    />
  );
}

export function SearchPicker({
  value,
  options: choices,
  labels,
  disabled = false,
  labelledBy,
  onChange,
}: {
  value: string;
  options: PickerOption[];
  labels: typeof timeZoneLabels;
  disabled?: boolean;
  labelledBy: string;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(value);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const revealActive = useRef(true);
  const tabTarget = useRef<HTMLElement | null>(null);
  const id = useId();
  const words = searchText(query).trim().split(/\s+/).filter(Boolean);
  const selected = choices.find((choice) => choice.value === value);
  const label = selected?.label ?? value;
  const matches = choices
    .filter((choice) =>
      words.every((word) =>
        searchText(`${choice.value} ${choice.label} ${choice.keywords ?? ''}`).includes(word),
      ),
    )
    .map((choice) => choice.value);
  const labelOf = (option: string) =>
    choices.find((choice) => choice.value === option)?.label ?? option;
  const activeIndex = Math.max(0, matches.indexOf(active));
  const activeZone = matches[activeIndex];
  const scrollActiveIntoView = useCallback(() => {
    const list = options.current;
    const option = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !option || !revealActive.current) return;
    const listBounds = list.getBoundingClientRect();
    const optionBounds = option.getBoundingClientRect();
    if (optionBounds.top < listBounds.top) list.scrollTop -= listBounds.top - optionBounds.top;
    else if (optionBounds.bottom > listBounds.bottom)
      list.scrollTop += optionBounds.bottom - listBounds.bottom;
  }, []);
  const observeOptions = useCallback(
    (node: HTMLDivElement | null) => {
      options.current = node;
      if (!node) return;
      let previousHeight = -1;
      const observer =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(([entry]) => {
              if (entry && entry.contentRect.height !== previousHeight) {
                previousHeight = entry.contentRect.height;
                scrollActiveIntoView();
              }
            });
      observer?.observe(node);
      return () => {
        observer?.disconnect();
        options.current = null;
      };
    },
    [scrollActiveIntoView],
  );
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      revealActive.current = true;
      setQuery('');
      setActive(value);
    }
  };
  const select = (zone: string) => {
    onChange(zone);
    setOpen(false);
  };
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (open) scrollActiveIntoView();
  }, [open, activeZone, query, scrollActiveIntoView]);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen} modal>
      <Popover.Trigger
        ref={trigger}
        type="button"
        className="time-zone-picker-trigger input select-trigger"
        disabled={disabled}
        aria-labelledby={`${labelledBy} ${id}-value`}
        title={label}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            changeOpen(true);
          }
        }}
      >
        <span id={`${id}-value`}>{label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="time-zone-picker-panel menu"
          aria-label={labels.choose}
          align="end"
          sideOffset={7}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            search.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (tabTarget.current?.isConnected) {
              tabTarget.current.focus();
            } else trigger.current?.focus({ preventScroll: true });
            tabTarget.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            const scope = trigger.current?.closest('[role="dialog"]') ?? document.body;
            const candidates = [
              ...scope.querySelectorAll<HTMLElement>('button,a,input,[tabindex]'),
            ].filter(
              (candidate) =>
                candidate.tabIndex >= 0 &&
                !candidate.hasAttribute('disabled') &&
                !candidate.closest('[hidden],[inert]') &&
                getComputedStyle(candidate).visibility !== 'hidden' &&
                getComputedStyle(candidate).display !== 'none',
            );
            const index = candidates.indexOf(trigger.current!);
            tabTarget.current = candidates[index + (event.shiftKey ? -1 : 1)] ?? trigger.current;
            setOpen(false);
          }}
        >
          <SearchField
            className="time-zone-picker-search"
            inputRef={search}
            type="text"
            role="combobox"
            aria-label={labels.search}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-options`}
            aria-activedescendant={activeZone ? `${id}-option-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={labels.placeholder}
            value={query}
            onChange={(event) => {
              revealActive.current = true;
              setQuery(event.target.value);
              setActive('');
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey)
                return;
              if (event.key === 'Enter') {
                event.preventDefault();
                if (activeZone) select(activeZone);
                return;
              }
              const next =
                event.key === 'ArrowDown'
                  ? (activeIndex + 1) % matches.length
                  : event.key === 'ArrowUp'
                    ? (activeIndex - 1 + matches.length) % matches.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? matches.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                if (matches[next]) {
                  revealActive.current = true;
                  setActive(matches[next]);
                  if (matches[next] === activeZone) scrollActiveIntoView();
                }
              }
            }}
            clearLabel={labels.clear}
            onClear={() => {
              revealActive.current = true;
              setQuery('');
              setActive(value);
              search.current?.focus({ preventScroll: true });
            }}
          />
          <div
            ref={observeOptions}
            id={`${id}-options`}
            role="listbox"
            aria-label={labels.list}
            className="time-zone-picker-options"
            onWheel={() => {
              revealActive.current = false;
            }}
            onPointerDown={() => {
              revealActive.current = false;
            }}
          >
            {matches.map((zone, index) => (
              <button
                key={zone}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                className="menu-item"
                aria-selected={zone === value}
                data-active={zone === activeZone}
                tabIndex={-1}
                onPointerMove={(event) => {
                  if (event.pointerType === 'mouse') {
                    revealActive.current = false;
                    setActive(zone);
                  }
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(zone)}
              >
                <span>{labelOf(zone)}</span>
                {zone === value && <Check size={16} aria-hidden="true" />}
              </button>
            ))}
          </div>
          {!matches.length && (
            <p className="time-zone-picker-empty" role="status">
              {labels.empty}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
