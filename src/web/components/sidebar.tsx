import { useEffect, useRef } from 'react';
import { PanelLeftOpen } from './icons';
import { Tooltip } from './tooltip';
import { desktopSettingsAvailable } from '../lib/desktop';
import { isEditingTarget, navigationShortcut, shortcutLabel } from '../lib/navigation';

export function Sidebar({
  nav,
  panelHidden = false,
  onToggle,
  onNavigate,
}: {
  nav: React.ReactNode;
  panelHidden?: boolean;
  onToggle(): void;
  onNavigate(path: string): void;
}) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const desktop = desktopSettingsAvailable();
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  useEffect(() => {
    let focusFrame: number | undefined;
    const down = (event: KeyboardEvent) => {
      const action = navigationShortcut(event, mac);
      if (!action || event.defaultPrevented) return;
      const composer =
        action.type === 'navigate' &&
        event.target instanceof Element &&
        event.target.closest('.composer .composer-editor[contenteditable="true"]') ===
          document.activeElement;
      if (
        (event.composedPath().some(isEditingTarget) || isEditingTarget(document.activeElement)) &&
        !composer
      )
        return;
      if (
        event
          .composedPath()
          .some((target) => target instanceof Element && Boolean(target.closest('[role="dialog"]')))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'sidebar') {
        if (window.innerWidth > 760) toggle.current();
        return;
      }
      navigate.current(action.path);
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = undefined;
        const target =
          action.path === '/'
            ? document.querySelector<HTMLElement>('.composer-editor[contenteditable="true"]')
            : document.getElementById('workspace');
        target?.focus();
      });
    };
    window.addEventListener('keydown', down);
    return () => {
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', down);
    };
  }, [mac]);
  return (
    <>
      <aside className="sidebar" aria-label="Sidebar">
        {nav}
      </aside>
      {panelHidden && (
        <Tooltip
          content="Show sidebar"
          shortcut={desktop ? shortcutLabel('b', mac) : undefined}
          side="right"
        >
          <button
            type="button"
            className="sidebar-show"
            aria-label="Show sidebar"
            onClick={() => onToggle()}
          >
            <PanelLeftOpen size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </>
  );
}
