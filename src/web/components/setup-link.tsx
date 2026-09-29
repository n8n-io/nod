import { Globe2, KeyRound, Link2 } from 'lucide-react';
import type { SetupKind } from '../lib/message-links';

const icons = { vault: KeyRound, website: Globe2, app: Link2 };

export function SetupActions({
  actions,
}: {
  actions: { href: string; setup: SetupKind; label: string }[];
}) {
  if (!actions.length) return null;
  return (
    <div className="setup-group">
      {actions.map(({ href, setup, label }) => {
        const Icon = icons[setup];
        return (
          <a
            key={href}
            data-setup={setup}
            href={href}
            target={href.startsWith('/apps?connect=') ? undefined : '_blank'}
            rel="noopener noreferrer"
            title={href.startsWith('https://') ? new URL(href).host : undefined}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </a>
        );
      })}
    </div>
  );
}
