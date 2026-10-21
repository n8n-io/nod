import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from './ui';
import { shortcutLabel } from '../lib/navigation';

export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle?(): void }) {
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="sidebar-toggle"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls="sidebar-navigation"
      aria-keyshortcuts="Meta+B Control+B"
      title={`${label} (${shortcutLabel('b', /Mac|iPhone|iPad/.test(navigator.platform))})`}
      disabled={!onToggle}
      onClick={onToggle}
    >
      {collapsed ? (
        <PanelLeftOpen size={16} aria-hidden="true" />
      ) : (
        <PanelLeftClose size={16} aria-hidden="true" />
      )}
    </Button>
  );
}
