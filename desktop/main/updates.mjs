import { randomUUID } from 'node:crypto';

const repository = 'n8n-io/otto';
const hash = /^[a-f0-9]{64}$/;
const sourceHash = /^[a-f0-9]{40}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(value) {
  if (typeof value !== 'string' || !versionPattern.test(value))
    throw new Error('The desktop update version is invalid.');
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error('The desktop update version is invalid.');
  return parts;
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

function https(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('The desktop update address is invalid.');
  return url.href;
}

function asset(release, name) {
  const matches = release.assets?.filter((entry) => entry.name === name) || [];
  const found = matches[0];
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(found.id) ||
    found.id < 1 ||
    !Number.isSafeInteger(found.size) ||
    found.size < 1 ||
    found.state !== 'uploaded'
  )
    throw new Error('The desktop release is incomplete.');
  return found;
}

function published(release, tag) {
  if (
    !release ||
    release.draft !== false ||
    release.tag_name !== tag ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    !Array.isArray(release.assets) ||
    release.assets.length > 30
  )
    throw new Error('The desktop release is unavailable.');
  return release;
}

async function json(url, request, signal, accept = 'application/json') {
  let address = https(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await request(address, {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
      headers: { accept },
      redirect: 'manual',
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      address = https(new URL(response.headers.get('location') || '', address).href);
      await response.body?.cancel();
      continue;
    }
    if (!response.ok || !response.body) throw new Error('Desktop updates are unavailable.');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('The desktop update response is too large.');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  throw new Error('The desktop update address redirected too many times.');
}

export function createUpdateSource({ sourceUrl, fetch: request = fetch } = {}) {
  const base = sourceUrl
    ? https(sourceUrl).replace(/\/$/, '')
    : `https://api.github.com/repos/${repository}`;
  if (/[?#]/.test(base)) throw new Error('The desktop update source is invalid.');
  const releasePath = (id) => `${base}/releases/${id}`;
  const assetUrl = (release, item) =>
    sourceUrl
      ? `${releasePath(release.id)}/assets/${item.id}/${encodeURIComponent(item.name)}`
      : `${base}/releases/assets/${item.id}`;
  const getAsset = (release, name, signal) =>
    json(assetUrl(release, asset(release, name)), request, signal, 'application/octet-stream');
  const runtimeDownloadUrl = async (runtime, signal) => {
    if (
      ![runtime?.fingerprint, runtime?.id, runtime?.archive?.sha256].every(
        (value) => typeof value === 'string' && hash.test(value),
      ) ||
      runtime.archive.file !== `Otto-Runtime-darwin-arm64-${runtime.id.slice(0, 12)}.tar.gz` ||
      !Number.isSafeInteger(runtime.archive.bytes) ||
      runtime.archive.bytes < 1
    )
      throw new Error('The desktop runtime metadata is incompatible.');
    const runtimeTag = `runtime-darwin-arm64-${runtime.fingerprint}`;
    const runtimeRelease = published(
      await json(
        sourceUrl ? `${base}/tags/${runtimeTag}` : `${base}/releases/tags/${runtimeTag}`,
        request,
        signal,
      ),
      runtimeTag,
    );
    const archive = asset(runtimeRelease, runtime.archive.file);
    if (archive.size !== runtime.archive.bytes)
      throw new Error('The desktop update runtime archive size does not match.');
    if (archive.digest !== `sha256:${runtime.archive.sha256}`)
      throw new Error('The desktop update runtime archive digest does not match.');
    return assetUrl(runtimeRelease, archive);
  };
  return {
    runtimeDownloadUrl,
    async latest(currentVersion, signal) {
      versionParts(currentVersion);
      const releases = await json(
        `${base}/releases${sourceUrl ? '' : '?per_page=100'}`,
        request,
        signal,
      );
      if (!Array.isArray(releases) || releases.length > (sourceUrl ? 500 : 100))
        throw new Error('The desktop release list is invalid.');
      const newer = releases
        .filter(
          (release) =>
            release?.draft === false &&
            /^desktop-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name) &&
            compareVersions(release.tag_name.slice(9), currentVersion) > 0,
        )
        .sort((a, b) => compareVersions(b.tag_name.slice(9), a.tag_name.slice(9)));
      if (!newer.length) return undefined;
      const listed = newer[0];
      if (!Number.isSafeInteger(listed.id) || listed.id < 1)
        throw new Error('The desktop release identity is invalid.');
      const release = published(
        await json(releasePath(listed.id), request, signal),
        listed.tag_name,
      );
      if (release.id !== listed.id) throw new Error('The desktop release identity changed.');
      const manifest = await getAsset(release, 'release.json', signal);
      const version = release.tag_name.slice(9);
      if (
        manifest.version !== version ||
        manifest.platform !== 'darwin-arm64' ||
        !sourceHash.test(manifest.source) ||
        !['self-signed', 'developer-id'].includes(manifest.signing?.mode) ||
        !hash.test(manifest.runtime?.fingerprint) ||
        !hash.test(manifest.runtime?.id) ||
        manifest.update?.file !== 'Otto-arm64.zip' ||
        !hash.test(manifest.update.sha256)
      )
        throw new Error('The desktop update metadata is incompatible.');
      const zip = asset(release, manifest.update.file);
      if (zip.size !== manifest.update.bytes)
        throw new Error('The desktop update archive size does not match.');
      if (zip.digest !== `sha256:${manifest.update.sha256}`)
        throw new Error('The desktop update archive digest does not match.');
      const runtime = await getAsset(release, 'runtime-release.json', signal);
      if (
        runtime.id !== manifest.runtime.id ||
        runtime.fingerprint !== manifest.runtime.fingerprint ||
        runtime.archive?.file !== manifest.runtime.archive?.file ||
        runtime.archive?.bytes !== manifest.runtime.archive?.bytes ||
        runtime.archive?.sha256 !== manifest.runtime.archive?.sha256
      )
        throw new Error('The desktop update runtime does not match.');
      const downloadUrl = await runtimeDownloadUrl(runtime, signal);
      let feedUrl;
      if (sourceUrl)
        feedUrl = `${releasePath(release.id)}/feed/${zip.id}?version=${currentVersion}&platform=darwin-arm64`;
      else {
        const feed = await getAsset(release, 'update.json', signal);
        const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${zip.name}`;
        if (feed.url !== expected) throw new Error('The desktop update feed does not match.');
        feedUrl = `https://github.com/${repository}/releases/download/${release.tag_name}/update.json`;
      }
      return {
        version,
        source: manifest.source,
        runtime,
        downloadUrl,
        feedUrl,
      };
    },
  };
}

export function createDesktopUpdater({
  source,
  currentVersion,
  native,
  prepareRuntime,
  restart,
  onStatus = () => {},
}) {
  let checking;
  let restarting;
  let ready;
  let disposed = false;
  const controller = new AbortController();
  const ignoreError = () => {};
  native.on('error', ignoreError);
  return {
    get ready() {
      return ready;
    },
    check() {
      if (disposed) return Promise.reject(new Error('Otto is closing.'));
      if (ready) return Promise.resolve(ready);
      if (checking) return checking;
      checking = (async () => {
        onStatus('checking');
        const candidate = await source.latest(currentVersion, controller.signal);
        if (!candidate) return undefined;
        if (compareVersions(candidate.version, currentVersion) <= 0)
          throw new Error('The desktop update is not newer than this app.');
        onStatus('preparing');
        await prepareRuntime(candidate, controller.signal);
        controller.signal.throwIfAborted();
        onStatus('downloading');
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            native.removeListener('error', failed);
            native.removeListener('update-downloaded', downloaded);
            native.removeListener('update-not-available', unavailable);
            controller.signal.removeEventListener('abort', aborted);
            error ? reject(error) : resolve();
          };
          const failed = (error) => finish(error);
          const downloaded = (_event, _notes, name) =>
            finish(
              name === `Otto ${candidate.version}`
                ? undefined
                : new Error('The downloaded update does not match the selected version.'),
            );
          const unavailable = () =>
            finish(new Error('The selected desktop update is unavailable.'));
          const aborted = () => finish(new Error('Otto is closing.'));
          native.once('error', failed);
          native.once('update-downloaded', downloaded);
          native.once('update-not-available', unavailable);
          controller.signal.addEventListener('abort', aborted, { once: true });
          try {
            native.setFeedURL({ url: https(candidate.feedUrl) });
            native.checkForUpdates();
          } catch (error) {
            finish(error);
          }
        });
        ready = candidate;
        return ready;
      })().finally(() => {
        checking = undefined;
        onStatus(ready ? 'ready' : 'idle');
      });
      return checking;
    },
    restart() {
      if (!ready || disposed) return Promise.reject(new Error('No desktop update is ready.'));
      if (restarting) return restarting;
      restarting = restart(ready).finally(() => {
        restarting = undefined;
      });
      return restarting;
    },
    dispose() {
      disposed = true;
      controller.abort();
      return checking?.catch(() => {});
    },
  };
}

export async function restartDesktopUpdate({
  candidate,
  guard,
  request,
  flush,
  shutdown,
  retryResume,
}) {
  const release = await guard();
  let transition;
  let closing = false;
  try {
    const status = await request('/api/desktop/status');
    if (!status.ok || (await status.json()).activeWork !== false)
      throw new Error('Finish or stop the current task before restarting Otto.');
    transition = {
      nonce: randomUUID(),
      targetRelease: candidate.source,
      deadline: Date.now() + 30_000,
    };
    const drained = await request('/api/runtime/drain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(transition),
      signal: AbortSignal.timeout(35_000),
    });
    if (!drained.ok || !(await drained.json()).drained)
      throw new Error('Otto is still finishing work. Try again shortly.');
    await flush();
    release.validate?.();
    closing = true;
    await shutdown();
  } catch (error) {
    if (closing) throw error;
    if (transition) {
      while (true) {
        try {
          const resumed = await request('/api/runtime/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(transition),
            signal: AbortSignal.timeout(35_000),
          });
          if (!resumed.ok || (await resumed.json()).ok !== true)
            throw new Error('Otto could not resume its work.');
          break;
        } catch {
          if (!(await retryResume?.())) throw new Error('Otto could not resume its work.');
        }
      }
    }
    release();
    throw error;
  }
}

export async function guardUpdateRenderers({ windows, ipc, trusted, timeout = 3000 }) {
  const token = randomUUID();
  const pending = new Set(windows.map((window) => window.webContents));
  let navigated = false;
  const navigation = () => {
    navigated = true;
  };
  for (const window of windows) window.webContents.on('did-start-navigation', navigation);
  const release = () => {
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      window.webContents.removeListener('did-start-navigation', navigation);
      window.webContents.send('otto:update:resume', token);
    }
  };
  release.validate = () => {
    if (navigated || windows.some((window) => window.isDestroyed()))
      throw new Error('An Otto window changed. Try restarting again.');
  };
  try {
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        ipc.removeListener('otto:update:prepared', receive);
        error ? reject(error) : resolve();
      };
      const receive = (event, value) => {
        if (!trusted(event) || !pending.has(event.sender) || value?.token !== token) return;
        if (value.blocked !== false) return fail();
        pending.delete(event.sender);
        if (!pending.size) finish();
      };
      const fail = () =>
        finish(new Error('Finish your draft and close other Otto windows before restarting.'));
      const timer = setTimeout(fail, timeout);
      ipc.on('otto:update:prepared', receive);
      try {
        for (const window of windows) window.webContents.send('otto:update:prepare', token);
        if (!pending.size) finish();
      } catch (error) {
        finish(error);
      }
    });
    release.validate();
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
