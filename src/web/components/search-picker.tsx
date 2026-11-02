import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from './icons';
import { Button, SearchField } from './ui';
import { Tooltip } from './tooltip';

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

interface PickerLabels {
  choose: string;
  search: string;
  placeholder: string;
  clear: string;
  list: string;
  empty: string;
}

type SearchPickerProps = {
  options: PickerOption[];
  labels: PickerLabels;
  disabled?: boolean;
  labelledBy?: string;
  className?: string;
  icon?: ReactNode;
} & (
  | { multiple?: false; value: string; onChange(value: string): void }
  | { multiple: true; value: string[]; triggerLabel: string; onChange(value: string[]): void }
);

export function SearchPicker(props: SearchPickerProps) {
  const { options: choices, labels, disabled = false, labelledBy, className = '', icon } = props;
  const selectedValues = props.multiple ? props.value : [props.value];
  const firstSelected = selectedValues[0] ?? '';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(firstSelected);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const revealActive = useRef(true);
  const tabTarget = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const id = useId();
  const words = searchText(query).trim().split(/\s+/).filter(Boolean);
  const selected = choices.find((choice) => choice.value === firstSelected);
  const label = props.multiple ? props.triggerLabel : (selected?.label ?? props.value);
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
  const activeValue = matches[activeIndex];
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
      setActive(firstSelected);
    }
  };
  const select = (value: string) => {
    if (props.multiple) {
      props.onChange(
        props.value.includes(value)
          ? props.value.filter((selected) => selected !== value)
          : [...props.value, value],
      );
      search.current?.focus({ preventScroll: true });
    } else {
      props.onChange(value);
      setOpen(false);
    }
  };
  useEffect(() => {
    if (disabled) setOpen(false);
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === document.body) trigger.current?.focus({ preventScroll: true });
    }
  }, [disabled]);
  useEffect(() => {
    if (open) scrollActiveIntoView();
  }, [open, activeValue, query, scrollActiveIntoView]);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen} modal>
      <Tooltip content={label}>
        <Popover.Trigger
          ref={trigger}
          type="button"
          className={`search-picker-trigger ${props.multiple ? 'button button-outline' : 'input select-trigger'} ${className}`}
          disabled={disabled}
          aria-labelledby={labelledBy ? `${labelledBy} ${id}-value` : undefined}
          aria-label={
            labelledBy
              ? undefined
              : `${label}${props.multiple && props.value.length ? ` (${props.value.length})` : ''}`
          }
          data-filtered={(props.multiple && props.value.length > 0) || undefined}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              changeOpen(true);
            }
          }}
        >
          {icon}
          <span id={`${id}-value`}>{label}</span>
          {props.multiple && props.value.length > 0 && (
            <span className="search-picker-count" aria-hidden="true">
              {props.value.length}
            </span>
          )}
          <ChevronDown size={12} aria-hidden="true" />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          className="search-picker-panel menu"
          data-multiple={props.multiple || undefined}
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
            } else if (trigger.current?.disabled) restoreFocus.current = true;
            else trigger.current?.focus({ preventScroll: true });
            tabTarget.current = null;
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Tab' ||
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey
            )
              return;
            const panel = event.currentTarget;
            const scope = trigger.current?.closest('[role="dialog"]') ?? document.body;
            const candidates = [
              ...scope.querySelectorAll<HTMLElement>('button,a,input,select,textarea,[tabindex]'),
            ].filter(
              (candidate) =>
                candidate.tabIndex >= 0 &&
                !candidate.matches(':disabled') &&
                !candidate.closest('[hidden],[inert]') &&
                candidate.getClientRects().length > 0 &&
                getComputedStyle(candidate).visibility !== 'hidden',
            );
            const inside = [...panel.querySelectorAll<HTMLElement>('input,button')].filter(
              (candidate) => candidate.tabIndex >= 0 && !candidate.matches(':disabled'),
            );
            const target = event.target as HTMLElement;
            const boundary = event.shiftKey ? inside[0] : inside.at(-1);
            if (target !== boundary) return;
            event.preventDefault();
            const outside = candidates.filter((candidate) => !panel.contains(candidate));
            const index = outside.indexOf(trigger.current!);
            tabTarget.current = outside[index + (event.shiftKey ? -1 : 1)] ?? trigger.current;
            setOpen(false);
          }}
        >
          <SearchField
            className="search-picker-search"
            inputRef={search}
            type="text"
            role="combobox"
            aria-label={labels.search}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-options`}
            aria-activedescendant={
              activeValue !== undefined ? `${id}-option-${activeIndex}` : undefined
            }
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
              if (
                event.defaultPrevented ||
                event.nativeEvent.isComposing ||
                event.altKey ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey
              )
                return;
              if (event.key === 'Enter') {
                event.preventDefault();
                if (activeValue !== undefined) select(activeValue);
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
                if (matches[next] !== undefined) {
                  revealActive.current = true;
                  setActive(matches[next]);
                  if (matches[next] === activeValue) scrollActiveIntoView();
                }
              }
            }}
            clearLabel={labels.clear}
            onClear={() => {
              revealActive.current = true;
              setQuery('');
              setActive(firstSelected);
              search.current?.focus({ preventScroll: true });
            }}
          />
          <div
            ref={observeOptions}
            id={`${id}-options`}
            role="listbox"
            aria-label={labels.list}
            aria-multiselectable={props.multiple || undefined}
            className="search-picker-options"
            onWheel={() => {
              revealActive.current = false;
            }}
            onPointerDown={() => {
              revealActive.current = false;
            }}
          >
            {matches.map((value, index) => (
              <button
                key={value}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                className="menu-item search-picker-option"
                aria-selected={selectedValues.includes(value)}
                data-active={value === activeValue}
                tabIndex={-1}
                onPointerMove={(event) => {
                  if (event.pointerType === 'mouse') {
                    revealActive.current = false;
                    setActive(value);
                  }
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(value)}
              >
                {props.multiple && (
                  <span className="search-picker-checkbox" aria-hidden="true">
                    {selectedValues.includes(value) && <Check size={12} />}
                  </span>
                )}
                <span className="search-picker-option-label">{labelOf(value)}</span>
                {!props.multiple && selectedValues.includes(value) && (
                  <Check size={16} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          {!matches.length && (
            <p className="search-picker-empty" role="status">
              {labels.empty}
            </p>
          )}
          {props.multiple && (
            <div className="search-picker-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!props.value.length}
                onClick={() => {
                  props.onChange([]);
                  search.current?.focus({ preventScroll: true });
                }}
              >
                Clear all
              </Button>
              <Popover.Close asChild>
                <Button type="button" variant="secondary" size="sm">
                  Done
                </Button>
              </Popover.Close>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
