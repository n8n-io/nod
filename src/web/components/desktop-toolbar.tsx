import type { Ref } from 'react';
import { SidebarToggle } from './sidebar-toggle';

export function DesktopToolbar({
  collapsed,
  onToggle,
  actionsRef,
}: {
  collapsed: boolean;
  onToggle?(): void;
  actionsRef?: Ref<HTMLDivElement>;
}) {
  return (
    <header className="desktop-toolbar">
      <SidebarToggle collapsed={collapsed} onToggle={onToggle} />
      <div className="desktop-toolbar-actions" ref={actionsRef} />
    </header>
  );
}
