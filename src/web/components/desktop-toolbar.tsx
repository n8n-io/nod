import { useEffect, useState, type Ref } from 'react';
import { desktopPcSharing, type PcSharingState } from '../lib/desktop';
import { Monitor } from './icons';

export function DesktopToolbar({ actionsRef }: { actionsRef?: Ref<HTMLDivElement> }) {
  const bridge = desktopPcSharing();
  const [state, setState] = useState<PcSharingState>('off');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!bridge) return;
    let current = true;
    let observed = false;
    const unsubscribe = bridge.subscribe((next) => {
      observed = true;
      if (current) setState(next);
    });
    void bridge.state().then(
      (next) => {
        if (current && !observed) setState(next);
      },
      () => {},
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [bridge]);
  const toggle = async () => {
    if (!bridge || pending) return;
    setPending(true);
    setError('');
    try {
      await (state === 'off' ? bridge.start() : bridge.stop());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  const label =
    state === 'off' ? 'Share PC' : state === 'connecting' ? 'Cancel connection' : 'Stop sharing PC';
  return (
    <header className="desktop-toolbar">
      {bridge && (
        <div className="pc-sharing-control">
          <button
            type="button"
            onClick={toggle}
            disabled={pending}
            aria-pressed={state !== 'off'}
            title={label}
            aria-label={label}
          >
            <Monitor size={16} />
            <span>{label}</span>
          </button>
          {error && <span role="alert">{error}</span>}
        </div>
      )}
      <div className="desktop-toolbar-actions" ref={actionsRef} />
    </header>
  );
}
