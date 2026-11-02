import type { Ref } from 'react';

export function DesktopToolbar({ actionsRef }: { actionsRef?: Ref<HTMLDivElement> }) {
  return (
    <header className="desktop-toolbar">
      <div className="desktop-toolbar-actions" ref={actionsRef} />
    </header>
  );
}
