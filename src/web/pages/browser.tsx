import { Monitor } from '../components/icons';
import { BrowserScreen } from '../components/browser-screen';
import { Loading, Notice } from '../components/ui';
import { useBrowserState } from '../hooks/use-browser-state';

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
      <BrowserScreen data={data} onStopped={browserStopped} />
    </main>
  );
}
