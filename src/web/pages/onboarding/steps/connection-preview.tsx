import type { RevealStep } from '../motion';

export const connectionSequence: RevealStep[] = [{ typing: 500 }, { wait: 200 }, { wait: 200 }];

export const emailCopy = {
  introduction:
    'I’m here to take things off your plate. Connect your email and I’ll look through your recent messages to suggest a few tasks I can handle for you.',
  action: 'Connect via Composio',
  note: 'Google or Microsoft will ask you to allow Composio, the service Nod uses to connect your apps.',
};

export function ComposioMark({ src = '/logos/composio.svg' }: { src?: string }) {
  return (
    <span
      className="ob-composio"
      aria-hidden="true"
      style={{ maskImage: `url(${src})`, WebkitMaskImage: `url(${src})` }}
    />
  );
}
