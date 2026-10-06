import { Monitor } from 'lucide-react';
import { InspectorScreen } from '../components/inspector-screen';
import { Loading, Notice } from '../components/ui';
import { useBrowserState } from '../hooks/use-inspector-state';

export function BrowserWindow() {
  const { data, error, browserStopped } = useBrowserState();
  return (
    <main className="browser-window">
      <header className="browser-window-heading">
        <div>
          <Monitor size={24} />
          <h1>Workspace browser</h1>
        </div>
      </header>
      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading label="Opening the browser view…" />}
      <InspectorScreen
        data={data}
        active
        onStopped={browserStopped}
        showDetails={false}
        screenPath="/api/browser/screen"
      />
    </main>
  );
}
