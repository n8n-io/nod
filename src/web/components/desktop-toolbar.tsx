import type { Ref } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from './ui';
import { shortcutLabel } from '../lib/navigation';

export function DesktopToolbar({
  collapsed,
  onToggle,
  actionsRef,
}: {
  collapsed: boolean;
  onToggle?(): void;
  actionsRef?: Ref<HTMLDivElement>;
}) {
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <header className="desktop-toolbar">
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-expanded={!collapsed}
        aria-controls="sidebar-navigation"
        aria-keyshortcuts="Meta+B Control+B"
        title={`${label} (${shortcutLabel('b', /Mac/.test(navigator.platform))})`}
        disabled={!onToggle}
        onClick={onToggle}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </Button>
      <div className="desktop-toolbar-actions" ref={actionsRef} />
    </header>
  );
}
