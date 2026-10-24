import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Flag, Gamepad2, Heart, Leaf, Lightbulb, Plane, Plus, Smile, Utensils } from './icons';
import { reactionEmoji } from '../../shared/emoji';
import { reactionName } from '../lib/reactions';
import { Loading } from './ui';
import { currentTheme, subscribeTheme } from '../lib/theme';

const commonReactions = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

const EmojiCatalog = lazy(async () => {
  const { default: Picker, Categories, EmojiStyle, Theme } = await import('emoji-picker-react');
  const EmojiPicker = (Picker as typeof Picker & { default?: typeof Picker }).default ?? Picker;
  const categoryIcons = {
    [Categories.SMILEYS_PEOPLE]: <Smile size={18} aria-hidden="true" />,
    [Categories.ANIMALS_NATURE]: <Leaf size={18} aria-hidden="true" />,
    [Categories.FOOD_DRINK]: <Utensils size={18} aria-hidden="true" />,
    [Categories.TRAVEL_PLACES]: <Plane size={18} aria-hidden="true" />,
    [Categories.ACTIVITIES]: <Gamepad2 size={18} aria-hidden="true" />,
    [Categories.OBJECTS]: <Lightbulb size={18} aria-hidden="true" />,
    [Categories.SYMBOLS]: <Heart size={18} aria-hidden="true" />,
    [Categories.FLAGS]: <Flag size={18} aria-hidden="true" />,
  };
  return {
    default: function Catalog({ onSelect }: { onSelect(emoji: string, name: string): void }) {
      const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light');
      return (
        <EmojiPicker
          emojiStyle={EmojiStyle.NATIVE}
          theme={theme === 'dark' ? Theme.DARK : Theme.LIGHT}
          width="100%"
          height="100%"
          categoryIcons={categoryIcons}
          autoFocusSearch
          searchPlaceholder="Search emoji"
          previewConfig={{ showPreview: false }}
          categories={[
            { category: Categories.SMILEYS_PEOPLE, name: 'Smileys and people' },
            { category: Categories.ANIMALS_NATURE, name: 'Animals and nature' },
            { category: Categories.FOOD_DRINK, name: 'Food and drink' },
            { category: Categories.TRAVEL_PLACES, name: 'Travel and places' },
            { category: Categories.ACTIVITIES, name: 'Activities' },
            { category: Categories.OBJECTS, name: 'Objects' },
            { category: Categories.SYMBOLS, name: 'Symbols' },
            { category: Categories.FLAGS, name: 'Flags' },
          ]}
          onEmojiClick={(selection) => {
            if (!selection.isCustom)
              onSelect(selection.emoji, selection.names.at(-1) ?? selection.emoji);
          }}
        />
      );
    },
  };
});

export default function ReactionPicker({
  expanded,
  selected,
  onExpand,
  onSelect,
}: {
  expanded: boolean;
  selected: string | null;
  onExpand(): void;
  onSelect(emoji: string, name: string): void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const initial = Math.max(0, commonReactions.indexOf(reactionEmoji(selected ?? '')));
  const [active, setActive] = useState(initial);
  useEffect(() => {
    if (!expanded)
      strip.current
        ?.querySelector<HTMLButtonElement>('[tabindex="0"]')
        ?.focus({ preventScroll: true });
  }, [expanded]);
  if (expanded)
    return (
      <Suspense fallback={<Loading label="Loading emoji…" />}>
        <EmojiCatalog onSelect={onSelect} />
      </Suspense>
    );
  return (
    <div
      className="chat-reaction-strip"
      role="toolbar"
      aria-label="Quick reactions"
      ref={strip}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (active + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
        setActive(next);
        buttons[next]?.focus({ preventScroll: true });
      }}
    >
      {commonReactions.map((emoji, index) => (
        <button
          key={emoji}
          type="button"
          aria-label={reactionName(emoji)}
          title={reactionName(emoji)}
          aria-pressed={reactionEmoji(selected ?? '') === emoji}
          tabIndex={active === index ? 0 : -1}
          onFocus={() => setActive(index)}
          onClick={() => onSelect(emoji, reactionName(emoji))}
        >
          <span aria-hidden="true">{emoji}</span>
        </button>
      ))}
      <button
        type="button"
        className="chat-reaction-more"
        aria-label="More emoji"
        title="More emoji"
        tabIndex={active === commonReactions.length ? 0 : -1}
        onFocus={() => setActive(commonReactions.length)}
        onClick={onExpand}
      >
        <Plus size={19} aria-hidden="true" />
      </button>
    </div>
  );
}
