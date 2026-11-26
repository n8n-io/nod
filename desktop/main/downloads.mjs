import { linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { downloadFileName } from './artifact-files.mjs';

export function saveArtifactDownload(event, item, { origin, directory, onError }) {
  let url;
  try {
    url = new URL(item.getURL());
  } catch {
    return false;
  }
  const chain = item.getURLChain();
  if (
    !origin ||
    url.origin !== origin ||
    url.href !== `${origin}${url.pathname}` ||
    !/^\/api\/artifacts\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      url.pathname,
    ) ||
    !item.hasUserGesture() ||
    item.getInitiatorOrigin() !== origin ||
    chain.length !== 1 ||
    chain[0] !== item.getURL()
  )
    return false;
  const name = basename(item.getFilename().replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '');
  const bounded = downloadFileName(name);
  const filename = bounded && bounded !== '.' && bounded !== '..' ? bounded : 'download';
  let staging;
  let path;
  const cleanup = () => {
    if (!staging) return;
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {}
  };
  const fail = async (recoveryPath) => {
    try {
      await onError(recoveryPath);
    } catch {}
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    staging = mkdtempSync(join(directory, '.nod-download-'));
    path = join(staging, 'download');
    item.setSavePath(path);
  } catch {
    event.preventDefault();
    cleanup();
    void fail();
    return true;
  }
  item.once('done', (_event, state) => {
    if (state !== 'completed') {
      cleanup();
      if (state === 'interrupted') void fail();
      return;
    }
    for (let suffix = 0; ; suffix++) {
      const target = join(directory, downloadFileName(filename, suffix));
      try {
        linkSync(path, target);
        break;
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        void fail(path);
        return;
      }
    }
    cleanup();
  });
  return true;
}
