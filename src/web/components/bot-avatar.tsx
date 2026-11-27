import { useRef } from 'react';
import { avatarUpload } from '../../shared/bots';
import { BrandMark } from './brand';

type Size = 'sm' | 'md' | 'lg';

export function NodAvatar({ size = 'md' }: { size?: Size }) {
  return (
    <span className={`av av-${size} av-nod`} aria-hidden="true">
      <BrandMark />
    </span>
  );
}

function useChangeKey(signature: string) {
  const shown = useRef(signature);
  const changed = useRef(false);
  if (shown.current !== signature) {
    shown.current = signature;
    changed.current = true;
  }
  return changed.current ? signature : undefined;
}

export function BotAvatar({
  name,
  avatar,
  size = 'md',
}: {
  name: string;
  avatar: string;
  size?: Size;
}) {
  const image = avatarUpload(avatar) ? avatar : '';
  const glyph = avatar || [...name.trim()][0]?.toUpperCase() || '?';
  const changeKey = useChangeKey(image || glyph);
  const changed = changeKey ? ' av-changed' : '';
  if (image)
    return (
      <span key={changeKey} className={`av av-${size} av-image${changed}`} aria-hidden="true">
        <img src={image} alt="" draggable={false} />
      </span>
    );
  return (
    <span
      key={changeKey}
      className={`av av-${size}${avatar ? ' av-mark' : ''}${changed}`}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}
