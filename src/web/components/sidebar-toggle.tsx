import { PanelLeftClose, PanelLeftOpen } from './icons';
import { Button } from './ui';
import { shortcutLabel } from '../lib/navigation';
import { desktopSettingsAvailable } from '../lib/desktop';

export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle?(): void }) {
  const desktop = desktopSettingsAvailable();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
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
      aria-keyshortcuts={desktop ? `${mac ? 'Meta' : 'Control'}+B` : undefined}
      title={desktop ? `${label} (${shortcutLabel('b', mac)})` : label}
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
