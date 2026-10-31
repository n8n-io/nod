import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ActionMenu, ActionMenuItem } from './action-menu';
import { Button } from './ui';
import { Check, ChevronDown } from './icons';

type Segment = 'hours' | 'minutes';
type TimePickerProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  changed?: boolean;
  savedValue?: string;
};

function parseTime(value: string) {
  const match =
    /^(\d{1,2}):([0-5]\d)$/.exec(value.trim()) ?? /^(\d{2})([0-5]\d)$/.exec(value.trim());
  if (!match || Number(match[1]) > 23) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}
function parseSegment(value: string, segment: Segment) {
  if (!/^\d{1,2}$/.test(value)) return null;
  const number = Number(value);
  return number <= (segment === 'hours' ? 23 : 59) ? number : null;
}
function parts(value: string) {
  const [hours, minutes] = value.split(':');
  return { hours, minutes };
}

export function TimePicker({
  id,
  label,
  value,
  onChange,
  disabled = false,
  invalid = false,
  changed = false,
  savedValue,
}: TimePickerProps) {
  const hintId = useId();
  const editedId = useId();
  const initial = parseTime(value) ?? parseTime(savedValue ?? '') ?? '00:00';
  const committed = useRef(initial);
  const [draft, setDraft] = useState(() => parts(initial));
  const draftRef = useRef(draft);
  const [announcement, setAnnouncement] = useState('');
  const [open, setOpen] = useState(false);
  const hoursRef = useRef<HTMLInputElement>(null);
  const minutesRef = useRef<HTMLInputElement>(null);
  const selectFrame = useRef(0);
  const selected = parseTime(value) ?? committed.current;
  const saved = parseTime(savedValue ?? '');
  const description = hintId + (changed ? ` ${editedId}` : '');
  const choices = [
    ...new Set([
      ...Array.from(
        { length: 96 },
        (_, index) =>
          `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`,
      ),
      selected,
    ]),
  ].sort();

  function updateDraft(next: { hours: string; minutes: string }) {
    draftRef.current = next;
    setDraft(next);
  }
  useEffect(() => {
    const next = parseTime(value);
    if (next && next !== committed.current) {
      committed.current = next;
      updateDraft(parts(next));
      setAnnouncement('');
    }
  }, [value]);
  useEffect(() => {
    if (!disabled) return;
    updateDraft(parts(committed.current));
    setOpen(false);
    setAnnouncement('');
  }, [disabled]);
  useEffect(() => () => cancelAnimationFrame(selectFrame.current), []);

  function focusSegment(segment: Segment) {
    const input = segment === 'hours' ? hoursRef.current : minutesRef.current;
    input?.focus({ preventScroll: true });
    input?.select();
  }
  function selectAfterRender(segment: Segment) {
    cancelAnimationFrame(selectFrame.current);
    selectFrame.current = requestAnimationFrame(() => {
      const input = segment === 'hours' ? hoursRef.current : minutesRef.current;
      if (document.activeElement === input) input?.select();
    });
  }
  function accept(time: string) {
    if (disabled) return;
    const next = parseTime(time);
    if (!next) return;
    const previous = committed.current;
    committed.current = next;
    updateDraft(parts(next));
    setAnnouncement('');
    if (next !== previous) onChange(next);
  }
  function commitSegment(segment: Segment) {
    const number = parseSegment(draftRef.current[segment], segment);
    if (number === null) {
      updateDraft(parts(committed.current));
      return;
    }
    const next = {
      ...parts(committed.current),
      [segment]: String(number).padStart(2, '0'),
    };
    accept(`${next.hours}:${next.minutes}`);
  }
  function reject(segment: Segment, fullTime = false) {
    updateDraft(parts(committed.current));
    setAnnouncement(
      fullTime
        ? 'Enter a valid 24-hour time, such as 09:30.'
        : `${segment === 'hours' ? 'Hours must be from 00 to 23' : 'Minutes must be from 00 to 59'}. Your time is unchanged.`,
    );
    selectAfterRender(segment);
  }
  function edit(segment: Segment, raw: string) {
    if (disabled) return;
    const text = raw.replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
    if (text === '') {
      updateDraft({ ...draftRef.current, [segment]: '' });
      setAnnouncement('');
      return;
    }
    if (parseSegment(text, segment) === null) {
      reject(segment);
      return;
    }
    updateDraft({ ...draftRef.current, [segment]: text });
    setAnnouncement('');
    if (text.length === 2) {
      commitSegment(segment);
      if (segment === 'hours') focusSegment('minutes');
      else selectAfterRender(segment);
    }
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>, segment: Segment) {
    if (
      disabled ||
      event.nativeEvent.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    )
      return;
    const maximum = segment === 'hours' ? 23 : 59;
    const current =
      parseSegment(draftRef.current[segment], segment) ?? Number(parts(committed.current)[segment]);
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? maximum
            : Math.max(0, Math.min(maximum, current + (event.key === 'ArrowUp' ? 1 : -1)));
      updateDraft({ ...draftRef.current, [segment]: String(next) });
      commitSegment(segment);
      selectAfterRender(segment);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === ':') {
      event.preventDefault();
      commitSegment(segment);
      focusSegment(event.key === 'ArrowLeft' ? 'hours' : 'minutes');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitSegment(segment);
      selectAfterRender(segment);
    } else if (
      event.key === 'Escape' &&
      draftRef.current[segment] !== parts(committed.current)[segment]
    ) {
      event.preventDefault();
      event.stopPropagation();
      updateDraft(parts(committed.current));
      setAnnouncement('');
      selectAfterRender(segment);
    }
  }
  function input(segment: Segment) {
    return (
      <input
        ref={segment === 'hours' ? hoursRef : minutesRef}
        id={segment === 'hours' ? id : `${id}-minutes`}
        className="settings-time-segment"
        type="text"
        role="spinbutton"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={draft[segment]}
        aria-label={`${label} ${segment}`}
        aria-valuemin={0}
        aria-valuemax={segment === 'hours' ? 23 : 59}
        aria-valuenow={
          parseSegment(draft[segment], segment) ?? Number(parts(committed.current)[segment])
        }
        aria-invalid={invalid || undefined}
        aria-describedby={description}
        onFocus={(event) => event.currentTarget.select()}
        onClick={(event) => event.currentTarget.select()}
        onBlur={() => commitSegment(segment)}
        onChange={(event) => {
          if ((event.nativeEvent as InputEvent).isComposing) {
            updateDraft({
              ...draftRef.current,
              [segment]: event.currentTarget.value,
            });
            return;
          }
          edit(segment, event.currentTarget.value);
        }}
        onCompositionEnd={(event) => edit(segment, event.currentTarget.value)}
        onKeyDown={(event) => keyDown(event, segment)}
        onPaste={(event) => {
          event.preventDefault();
          if (disabled) return;
          const text = event.clipboardData.getData('text').trim();
          const time = parseTime(text);
          if (time) {
            accept(time);
            focusSegment('minutes');
            selectAfterRender('minutes');
          } else if (parseSegment(text, segment) !== null) {
            updateDraft({ ...draftRef.current, [segment]: text });
            commitSegment(segment);
            selectAfterRender(segment);
          } else reject(segment, true);
        }}
      />
    );
  }

  return (
    <div className="field settings-time-field" data-changed={changed || undefined}>
      <div className="settings-time-heading">
        <label className="field-label" id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
        <span className="settings-time-edited" id={editedId}>
          {changed ? (saved ? `Was ${saved}` : 'Edited') : ''}
        </span>
      </div>
      <div
        className="settings-time-control"
        role="group"
        aria-labelledby={`${id}-label`}
        data-disabled={disabled || undefined}
        data-invalid={invalid || undefined}
        data-open={open || undefined}
      >
        {input('hours')}
        <span className="settings-time-colon" aria-hidden="true">
          :
        </span>
        {input('minutes')}
        <ActionMenu
          label={`Choose ${label.toLowerCase()} time`}
          contentClassName="settings-time-menu"
          open={open}
          onOpenChange={setOpen}
          disabled={disabled}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="settings-time-toggle"
              disabled={disabled}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
          }
        >
          {(close) =>
            choices.map((time) => (
              <ActionMenuItem
                key={time}
                checked={time === selected}
                textValue={time}
                onClick={() => {
                  accept(time);
                  close();
                }}
              >
                <span>{time}</span>
                {time === selected && <Check size={15} aria-hidden="true" />}
              </ActionMenuItem>
            ))
          }
        </ActionMenu>
      </div>
      <span className="sr-only" id={hintId}>
        24-hour time. Type hours and minutes. Up and down change the value; left and right move
        between hours and minutes.
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
