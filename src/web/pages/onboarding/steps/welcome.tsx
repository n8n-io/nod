import { useEffect } from 'react';
import { NodGlyph } from '../../../components/motion';
import { Button } from '../../../components/ui';
import type { StepProps } from '..';

export function Welcome({ onNext }: StepProps) {
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
    <section className="ob-step ob-welcome" data-analytics-public>
      <div className="ob-welcome-content">
        <h1 className="ob-welcome-wordmark" aria-label="nod">
          <NodGlyph size={80} mode="bounce" className="ob-welcome-mark" />
          <span aria-hidden="true">nod</span>
        </h1>
        <p className="ob-welcome-copy">
          Real tasks, done for you, on your
          <br className="ob-welcome-break" /> computer, with your permission.
        </p>
        <Button onClick={onNext}>Get started</Button>
      </div>
      <p className="ob-welcome-note">This is a preview version of nod, developed by n8n</p>
    </section>
  );
}
