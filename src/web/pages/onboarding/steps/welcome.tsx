import { useEffect, type CSSProperties } from 'react';
import { DataSharing } from '../../../components/data-sharing';
import { LockKeyhole, MousePointerClick, ShieldCheck, Sparkles } from '../../../components/icons';
import { NodGlyph } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { desktopRuntimeAvailable } from '../../../lib/desktop';
import { legalLinks } from '../../../../shared/onboarding';
import type { StepProps } from '..';

function differentiators(local: boolean) {
  return [
    {
      icon: MousePointerClick,
      title: 'Gets tasks done',
      text: 'Nod uses your apps and its own browser to complete tasks.',
    },
    {
      icon: Sparkles,
      title: 'Works proactively',
      text: 'Nod checks the apps you connect in the background, using your model, and only notifies you when it matters.',
    },
    {
      icon: LockKeyhole,
      title: `Runs on your ${local ? 'computer' : 'server'}`,
      text: 'Nod works in a private workspace. Sign in with your AI provider or use your own key.',
    },
    {
      icon: ShieldCheck,
      title: 'Keeps you in control',
      text: 'Nod asks you before taking potentially dangerous actions.',
    },
  ];
}

export function Welcome({
  onNext,
  usageShared,
  traces,
  actionLabel = 'Get started',
  local = desktopRuntimeAvailable() ||
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname),
}: StepProps & { actionLabel?: string; local?: boolean }) {
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const surface =
        event.target === document.body || event.target === document.querySelector('.ob-main');
      if (event.key !== 'Enter' || !surface || event.repeat) return;
      onNext();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [onNext]);

  return (
    <section className="ob-step ob-welcome">
      <div className="ob-welcome-content">
        <h1 className="ob-welcome-wordmark" aria-label="Nod">
          <NodGlyph size={48} mode="bounce" className="ob-welcome-mark" />
          <span aria-hidden="true">Nod</span>
        </h1>
        <p className="ob-welcome-copy">An assistant that takes work off your plate.</p>
        <ul className="ob-welcome-points">
          {differentiators(local).map(({ icon: Icon, title, text }, index) => (
            <li
              key={title}
              className="ob-welcome-point"
              style={{ '--point-delay': `${200 + index * 90}ms` } as CSSProperties}
            >
              <span className="ob-welcome-point-icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span>
                <strong>{title}</strong>
                <span>{text}</span>
              </span>
            </li>
          ))}
        </ul>
        {usageShared && (
          <p className="ob-welcome-usage">
            Please keep usage data on so the Nod team can see where I get stuck.
            <br />
            <DataSharing className="ob-link" usage traces={traces?.enabled} />
          </p>
        )}
        <Button onClick={onNext}>{actionLabel}</Button>
      </div>
      <p className="ob-welcome-note">
        This is a preview version of Nod, developed by n8n
        <br />
        <a className="ob-link" href={legalLinks.terms} target="_blank" rel="noreferrer">
          Terms of Use
        </a>
        {' · '}
        <a className="ob-link" href={legalLinks.privacy} target="_blank" rel="noreferrer">
          Privacy policy
        </a>
      </p>
    </section>
  );
}
