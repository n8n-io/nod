import { createContext, useContext } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from './ui';
import { shortcutLabel } from '../lib/navigation';

export const SidebarToggleContext = createContext<{ collapsed: boolean; toggle(): void } | null>(
  null,
);

export function SidebarToggle() {
  const sidebar = useContext(SidebarToggleContext);
  if (!sidebar) return null;
  const label = sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="sidebar-toggle"
      aria-label={label}
      aria-expanded={!sidebar.collapsed}
      aria-controls="sidebar-navigation"
      aria-keyshortcuts="Meta+B Control+B"
      title={`${label} (${shortcutLabel('b', /Mac|iPhone|iPad/.test(navigator.platform))})`}
      onClick={sidebar.toggle}
    >
      {sidebar.collapsed ? (
        <PanelLeftOpen size={16} aria-hidden="true" />
      ) : (
        <PanelLeftClose size={16} aria-hidden="true" />
      )}
    </Button>
  );
}
