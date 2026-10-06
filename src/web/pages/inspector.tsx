import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Monitor,
  X,
  Coins,
  Wrench,
  ScrollText,
  BrainCircuit,
  ChevronDown,
} from 'lucide-react';
import type { Turn } from '../../shared/contracts';
import { Button, Notice } from '../components/ui';
import { InspectorScreen } from '../components/inspector-screen';
import { useInspectorState } from '../hooks/use-inspector-state';
import { InspectorActivity, InspectorModels, InspectorTools } from '../components/inspector-tools';
import { InspectorProviders } from '../components/inspector-providers';
import { InspectorPrompts } from '../components/inspector-prompts';
import { ConnectionMenu } from '../components/connection-menu';
import { statusLabels } from '../components/turn-status';
import { readUiPreference, writeUiPreference } from '../lib/ui-preferences';
import { formatDateTime, useDateFormat } from '../lib/date-format';

const sourceLabels: Record<Turn['source'], string> = {
  user: 'Message',
  schedule: 'Schedule',
  event: 'Event',
  resume: 'Resume',
};

function turnLabel(turn: Turn) {
  return `${sourceLabels[turn.source]} · ${formatDateTime(turn.createdAt)} · ${statusLabels[turn.status]}`;
}

export function Inspector({
  onClose,
  focus,
}: {
  onClose(): void;
  focus?: { messageId: string; turnId: string };
}) {
  useDateFormat();
  const { data, error, browserStopped } = useInspectorState();
  const [scope, setScope] = useState(focus?.turnId);
  const [scopeSource, setScopeSource] = useState<'message' | 'picked'>('message');
  const [width, setWidth] = useState(() =>
    Math.max(330, Math.min(900, Number(readUiPreference('otto.inspector.width')) || 480)),
  );
  useEffect(() => {
    if (focus?.turnId) {
      setScope(focus.turnId);
      setScopeSource('message');
      setTab('tools');
    }
  }, [focus]);
  useEffect(() => {
    writeUiPreference('otto.inspector.width', String(width));
  }, [width]);
  const [tab, setTab] = useState<'screen' | 'activity' | 'tools' | 'models' | 'costs' | 'prompts'>(
    'screen',
  );
  const panel = useRef<HTMLElement>(null);
  const turns = data?.turns ?? [];
  const turn = turns.find((item) => item.id === scope);
  const events = data?.events.filter((event) => !scope || event.turnId === scope) ?? [];
  const views = [
    ['screen', 'Screen', Monitor],
    ['activity', 'Activity', Activity],
    ['tools', 'Tools', Wrench],
    ['models', 'Models', BrainCircuit],
    ['costs', 'Costs', Coins],
    ['prompts', 'Prompts', ScrollText],
  ] as const;
  return (
    <aside
      id="developer-inspector"
      ref={panel}
      className="inspector-panel"
      style={{ '--inspector-width': `${width}px` } as React.CSSProperties}
      aria-label="Developer inspector"
    >
      <div
        className="inspector-resizer"
        role="separator"
        aria-label="Resize inspector"
        aria-orientation="vertical"
        aria-valuemin={330}
        aria-valuemax={900}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            setWidth((value) =>
              Math.max(330, Math.min(900, value + (event.key === 'ArrowLeft' ? 40 : -40))),
            );
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setWidth(Math.max(330, Math.min(900, window.innerWidth - event.clientX)));
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      />
      <header className="inspector-heading">
        <div>
          <Monitor size={16} />
          <h2>Inspector</h2>
          <span className="dev-label">DEV</span>
        </div>
        <div>
          <Button variant="ghost" size="icon" aria-label="Close inspector" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
        {views.map(([value, label, Icon], index) => (
          <button
            role="tab"
            aria-selected={tab === value}
            id={`inspector-tab-${value}`}
            aria-controls={`inspector-view-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onKeyDown={(event) => {
              const target =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? views.length - 1
                    : event.key === 'ArrowRight'
                      ? (index + 1) % views.length
                      : event.key === 'ArrowLeft'
                        ? (index + views.length - 1) % views.length
                        : -1;
              if (target < 0) return;
              event.preventDefault();
              const next = views[target]![0];
              setTab(next);
              document.getElementById(`inspector-tab-${next}`)?.focus();
            }}
            key={value}
            onClick={() => setTab(value)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      {error && <Notice>{error}</Notice>}
      <div
        className="inspector-body"
        role="tabpanel"
        id={`inspector-view-${tab}`}
        aria-labelledby={`inspector-tab-${tab}`}
        tabIndex={0}
      >
        {tab !== 'screen' && tab !== 'costs' && (scope || turns.length > 0) && (
          <div className="inspector-scope">
            <span>
              {scope
                ? `${scopeSource === 'message' ? 'From this message' : 'This turn'}${turn ? ': ' + turnLabel(turn) : ''}`
                : 'All activity'}
            </span>
            {turns.length > 0 && (
              <ConnectionMenu
                label="Choose a turn"
                trigger={
                  <>
                    Turn
                    <ChevronDown size={16} aria-hidden="true" />
                  </>
                }
              >
                {(close) => (
                  <>
                    <button
                      type="button"
                      className="menu-item"
                      role="menuitemradio"
                      aria-checked={!scope}
                      onClick={() => {
                        setScope(undefined);
                        close();
                      }}
                    >
                      All activity
                    </button>
                    {turns.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className="menu-item"
                        role="menuitemradio"
                        aria-checked={item.id === scope}
                        onClick={() => {
                          setScope(item.id);
                          setScopeSource('picked');
                          close();
                        }}
                      >
                        {turnLabel(item)}
                      </button>
                    ))}
                  </>
                )}
              </ConnectionMenu>
            )}
            {scope && (
              <Button variant="ghost" size="sm" onClick={() => setScope(undefined)}>
                Show all
              </Button>
            )}
          </div>
        )}
        <InspectorScreen
          data={data}
          active={tab === 'screen'}
          onStopped={browserStopped}
          allowDetach
        />
        {tab === 'activity' &&
          (scope ? (
            <InspectorActivity key={scope} turnId={scope} events={events} />
          ) : (
            <InspectorActivity events={events} />
          ))}
        {tab === 'tools' && <InspectorTools key={scope ?? 'all'} turnId={scope} />}
        {tab === 'models' && <InspectorModels key={scope ?? 'all'} turnId={scope} />}
        {tab === 'costs' && <InspectorProviders />}
        {tab === 'prompts' && <InspectorPrompts key={scope ?? 'all'} turnId={scope} />}
      </div>
    </aside>
  );
}
