export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-glyph ${small ? 'brand-glyph-small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="10" stroke="currentColor" strokeWidth="4" />
        <circle cx="25" cy="6" r="4" fill="var(--brand-pink)" />
      </svg>
    </span>
  );
}
