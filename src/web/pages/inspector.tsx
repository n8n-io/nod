import { useEffect, useRef, useState } from 'react';
import { Activity, Monitor, X, Coins, Wrench, ScrollText, BrainCircuit } from 'lucide-react';
import { Button, Notice } from '../components/ui';
import { InspectorScreen } from '../components/inspector-screen';
import { useInspectorState } from '../hooks/use-inspector-state';
import { InspectorActivity, InspectorModels, InspectorTools } from '../components/inspector-tools';
import { compactActivityText } from '../lib/inspector-observations';
import { InspectorProviders } from '../components/inspector-providers';
import { InspectorPrompts } from '../components/inspector-prompts';
import { InspectorWork } from '../components/inspector-work';
import { readUiPreference, writeUiPreference } from '../lib/ui-preferences';
import { useDateFormat } from '../lib/date-format';

export function Inspector({
  onClose,
  focus,
}: {
  onClose(): void;
  focus?: { messageId: string; taskId: string };
}) {
  useDateFormat();
  const { data, error, browserStopped } = useInspectorState();
  const [scope, setScope] = useState(focus?.taskId);
  const [scopeSource, setScopeSource] = useState<'message' | 'work'>('message');
  const [width, setWidth] = useState(() =>
    Math.max(330, Math.min(900, Number(readUiPreference('otto.inspector.width')) || 480)),
  );
  useEffect(() => {
    if (focus?.taskId) {
      setScope(focus.taskId);
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
  const task = data?.tasks.find((item) => item.id === scope);
  const events = data?.events.filter((event) => !scope || event.taskId === scope) ?? [];
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
          <Monitor size={17} />
          <h2>Inspector</h2>
          <span className="dev-label">DEV</span>
        </div>
        <div>
          <Button variant="ghost" size="icon" aria-label="Close inspector" onClick={onClose}>
            <X size={17} />
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
            <Icon size={14} />
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
        {tab !== 'screen' && tab !== 'costs' && scope && (
          <div className="inspector-scope">
            <span>
              {scope
                ? `${scopeSource === 'message' ? 'From this message' : 'This work'}${task ? ': ' + compactActivityText(task.title, 65) : ''}`
                : 'All activity'}
            </span>
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
            <InspectorActivity key={scope} taskId={scope} events={events} />
          ) : (
            <>
              <InspectorWork
                onInspect={(taskId) => {
                  setScope(taskId);
                  setScopeSource('work');
                  setTab('tools');
                }}
              />
              <InspectorActivity events={events} />
            </>
          ))}
        {tab === 'tools' && <InspectorTools key={scope ?? 'all'} taskId={scope} />}
        {tab === 'models' && <InspectorModels key={scope ?? 'all'} taskId={scope} />}
        {tab === 'costs' && <InspectorProviders />}
        {tab === 'prompts' && <InspectorPrompts key={scope ?? 'all'} taskId={scope} />}
      </div>
    </aside>
  );
}
