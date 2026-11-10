const defaultRepository = 'n8n-io/nod';
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

function compareVersions(left, right) {
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

async function githubReleaseTag(repository, name, request, signal) {
  const alias = `https://github.com/${repository}/releases/latest/download/${name}`;
  const response = await request(alias, {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    redirect: 'manual',
  });
  await response.body?.cancel();
  const target = new URL(response.headers.get('location') || '', alias);
  const prefix = `/${repository}/releases/download/`;
  const path = target.pathname.slice(prefix.length);
  const slash = path.indexOf('/');
  const tag = path.slice(0, slash);
  if (
    response.status !== 302 ||
    target.origin !== 'https://github.com' ||
    !target.pathname.startsWith(prefix) ||
    target.search ||
    target.hash ||
    slash < 1 ||
    path.slice(slash + 1) !== name ||
    !/^nod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
  )
    throw new Error('The latest desktop release is invalid.');
  versionParts(tag.slice(5));
  return tag;
}

export function createUpdateSource({
  sourceUrl,
  repository = defaultRepository,
  os = process.platform === 'win32' ? 'win32' : 'darwin',
  arch = process.platform === 'darwin' ? process.arch : 'arm64',
  fetch: request = fetch,
} = {}) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository))
    throw new Error('The desktop update repository is invalid.');
  if (os === 'darwin' && !['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported Mac update architecture.');
  if (!['darwin', 'win32'].includes(os)) throw new Error('Unsupported desktop update platform.');
  const platform = os === 'win32' ? 'win32-x64' : `darwin-${arch}`;
  const metadataName = (name) => (arch === 'arm64' ? `${name}.json` : `${name}-darwin-x64.json`);
  const direct = (tag, name) =>
    `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`;
  if (!sourceUrl) {
    const latestManifest = async (name, currentVersion, signal) => {
      versionParts(currentVersion);
      const tag = await githubReleaseTag(repository, name, request, signal);
      const version = tag.slice(5);
      if (compareVersions(version, currentVersion) <= 0) return undefined;
      return {
        tag,
        version,
        manifest: await json(direct(tag, name), request, signal, 'application/octet-stream'),
      };
    };
    if (os === 'win32')
      return {
        async runtimeDownloadUrl(runtime) {
          if (
            !/^nod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(runtime?.releaseTag) ||
            !hash.test(runtime.guest?.sha256) ||
            !Number.isSafeInteger(runtime.guest.bytes) ||
            runtime.guest.bytes < 1
          )
            throw new Error('The desktop runtime metadata is incompatible.');
          return direct(runtime.releaseTag, 'nod-Runtime-win32-x64.tar.gz');
        },
        async latest(currentVersion, signal) {
          const found = await latestManifest('release-win32-x64.json', currentVersion, signal);
          if (!found) return undefined;
          const { tag, version, manifest } = found;
          if (
            manifest.version !== version ||
            manifest.platform !== platform ||
            !sourceHash.test(manifest.source) ||
            manifest.installer?.file !== 'nod-Setup-x64.exe' ||
            manifest.runtime?.file !== 'nod-Runtime-win32-x64.tar.gz'
          )
            throw new Error('The desktop update metadata is incompatible.');
          const files = {};
          for (const key of ['installer', 'runtime']) {
            const entry = manifest[key];
            if (!hash.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1)
              throw new Error('The desktop update files do not match their metadata.');
            files[key] = { ...entry, url: direct(tag, entry.file) };
          }
          return { version, source: manifest.source, ...files };
        },
      };
    const runtimeDownloadUrl = async (runtime) => {
      if (
        ![runtime?.fingerprint, runtime?.id, runtime?.archive?.sha256].every(
          (value) => typeof value === 'string' && hash.test(value),
        ) ||
        runtime.archive.file !== `nod-Runtime-${platform}-${runtime.id.slice(0, 12)}.tar.gz` ||
        !Number.isSafeInteger(runtime.archive.bytes) ||
        runtime.archive.bytes < 1 ||
        runtime.platform !== platform ||
        !/^nod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(runtime.releaseTag)
      )
        throw new Error('The desktop runtime metadata is incompatible.');
      return direct(runtime.releaseTag, runtime.archive.file);
    };
    return {
      runtimeDownloadUrl,
      async latest(currentVersion, signal) {
        const found = await latestManifest(metadataName('release'), currentVersion, signal);
        if (!found) return undefined;
        const { tag, version, manifest } = found;
        if (
          manifest.version !== version ||
          manifest.platform !== platform ||
          !sourceHash.test(manifest.source) ||
          !['self-signed', 'developer-id'].includes(manifest.signing?.mode) ||
          !hash.test(manifest.runtime?.fingerprint) ||
          !hash.test(manifest.runtime?.id) ||
          manifest.update?.file !== `nod-${arch}.zip` ||
          !hash.test(manifest.update.sha256) ||
          !Number.isSafeInteger(manifest.update.bytes) ||
          manifest.update.bytes < 1
        )
          throw new Error('The desktop update metadata is incompatible.');
        const runtime = await json(
          direct(tag, metadataName('runtime-release')),
          request,
          signal,
          'application/octet-stream',
        );
        if (
          runtime.id !== manifest.runtime.id ||
          runtime.fingerprint !== manifest.runtime.fingerprint ||
          runtime.archive?.file !== manifest.runtime.archive?.file ||
          runtime.archive?.bytes !== manifest.runtime.archive?.bytes ||
          runtime.archive?.sha256 !== manifest.runtime.archive?.sha256
        )
          throw new Error('The desktop update runtime does not match.');
        const downloadUrl = await runtimeDownloadUrl(runtime);
        const feed = await json(
          direct(tag, metadataName('update')),
          request,
          signal,
          'application/octet-stream',
        );
        if (
          feed.url !== direct(tag, manifest.update.file) ||
          ![`Nod ${version}`, `nod ${version}`].includes(feed.name)
        )
          throw new Error('The desktop update feed does not match.');
        return {
          version,
          source: manifest.source,
          runtime,
          downloadUrl,
          feedUrl: direct(tag, metadataName('update')),
        };
      },
    };
  }
  const base = https(sourceUrl).replace(/\/$/, '');
  if (/[?#]/.test(base)) throw new Error('The desktop update source is invalid.');
  const releasePath = (id) => `${base}/releases/${id}`;
  const assetUrl = (release, item) =>
    `${releasePath(release.id)}/assets/${item.id}/${encodeURIComponent(item.name)}`;
  const getAsset = (release, name, signal) =>
    json(assetUrl(release, asset(release, name)), request, signal, 'application/octet-stream');
  const releaseAssetUrl = async (tag, { file, bytes, sha256 }, signal) => {
    const release = published(await json(`${base}/tags/${tag}`, request, signal), tag);
    const archive = asset(release, file);
    if (archive.size !== bytes)
      throw new Error('The desktop update runtime archive size does not match.');
    if (archive.digest !== `sha256:${sha256}`)
      throw new Error('The desktop update runtime archive digest does not match.');
    return assetUrl(release, archive);
  };
  const runtimeDownloadUrl = async (runtime, signal) => {
    if (
      ![runtime?.fingerprint, runtime?.id, runtime?.archive?.sha256].every(
        (value) => typeof value === 'string' && hash.test(value),
      ) ||
      runtime.archive.file !== `nod-Runtime-${platform}-${runtime.id.slice(0, 12)}.tar.gz` ||
      !Number.isSafeInteger(runtime.archive.bytes) ||
      runtime.archive.bytes < 1
    )
      throw new Error('The desktop runtime metadata is incompatible.');
    if (
      runtime.platform !== platform ||
      !/^nod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(runtime.releaseTag)
    )
      throw new Error('The desktop runtime target is incompatible.');
    return releaseAssetUrl(runtime.releaseTag, runtime.archive, signal);
  };
  const newest = async (currentVersion, signal, resolve) => {
    versionParts(currentVersion);
    const releases = await json(`${base}/releases`, request, signal);
    if (!Array.isArray(releases) || releases.length > 500)
      throw new Error('The desktop release list is invalid.');
    const newer = releases
      .filter(
        (release) =>
          release?.draft === false &&
          /^nod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name) &&
          compareVersions(release.tag_name.slice(5), currentVersion) > 0,
      )
      .sort((a, b) => compareVersions(b.tag_name.slice(5), a.tag_name.slice(5)));
    let failure;
    for (const listed of newer.slice(0, 3)) {
      try {
        if (!Number.isSafeInteger(listed.id) || listed.id < 1)
          throw new Error('The desktop release identity is invalid.');
        const release = published(
          await json(releasePath(listed.id), request, signal),
          listed.tag_name,
        );
        if (release.id !== listed.id) throw new Error('The desktop release identity changed.');
        return await resolve(release);
      } catch (error) {
        signal?.throwIfAborted();
        failure ??= error;
      }
    }
    if (failure) throw failure;
    return undefined;
  };
  if (os === 'win32')
    return {
      async runtimeDownloadUrl(runtime, signal) {
        if (
          !/^nod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(runtime?.releaseTag) ||
          !hash.test(runtime.guest?.sha256) ||
          !Number.isSafeInteger(runtime.guest.bytes) ||
          runtime.guest.bytes < 1
        )
          throw new Error('The desktop runtime metadata is incompatible.');
        return releaseAssetUrl(
          runtime.releaseTag,
          { ...runtime.guest, file: 'nod-Runtime-win32-x64.tar.gz' },
          signal,
        );
      },
      latest: (currentVersion, signal) =>
        newest(currentVersion, signal, async (release) => {
          const version = release.tag_name.slice(5);
          const manifest = await getAsset(release, 'release-win32-x64.json', signal);
          if (
            manifest.version !== version ||
            manifest.platform !== platform ||
            !sourceHash.test(manifest.source) ||
            manifest.installer?.file !== 'nod-Setup-x64.exe' ||
            manifest.runtime?.file !== 'nod-Runtime-win32-x64.tar.gz'
          )
            throw new Error('The desktop update metadata is incompatible.');
          const files = {};
          for (const key of ['installer', 'runtime']) {
            const entry = manifest[key];
            const item = asset(release, entry.file);
            if (
              !hash.test(entry.sha256) ||
              item.size !== entry.bytes ||
              item.digest !== `sha256:${entry.sha256}`
            )
              throw new Error('The desktop update files do not match their metadata.');
            files[key] = {
              file: entry.file,
              bytes: entry.bytes,
              sha256: entry.sha256,
              url: assetUrl(release, item),
            };
          }
          return { version, source: manifest.source, ...files };
        }),
    };
  return {
    runtimeDownloadUrl,
    latest: (currentVersion, signal) =>
      newest(currentVersion, signal, async (release) => {
        const manifest = await getAsset(release, metadataName('release'), signal);
        const version = release.tag_name.slice(5);
        if (
          manifest.version !== version ||
          manifest.platform !== platform ||
          !sourceHash.test(manifest.source) ||
          !['self-signed', 'developer-id'].includes(manifest.signing?.mode) ||
          !hash.test(manifest.runtime?.fingerprint) ||
          !hash.test(manifest.runtime?.id) ||
          manifest.update?.file !== `nod-${arch}.zip` ||
          !hash.test(manifest.update.sha256)
        )
          throw new Error('The desktop update metadata is incompatible.');
        const zip = asset(release, manifest.update.file);
        if (zip.size !== manifest.update.bytes)
          throw new Error('The desktop update archive size does not match.');
        if (zip.digest !== `sha256:${manifest.update.sha256}`)
          throw new Error('The desktop update archive digest does not match.');
        const runtime = await getAsset(release, metadataName('runtime-release'), signal);
        if (
          runtime.id !== manifest.runtime.id ||
          runtime.fingerprint !== manifest.runtime.fingerprint ||
          runtime.archive?.file !== manifest.runtime.archive?.file ||
          runtime.archive?.bytes !== manifest.runtime.archive?.bytes ||
          runtime.archive?.sha256 !== manifest.runtime.archive?.sha256
        )
          throw new Error('The desktop update runtime does not match.');
        const downloadUrl = await runtimeDownloadUrl(runtime, signal);
        const feedUrl = `${releasePath(release.id)}/feed/${zip.id}?version=${currentVersion}&platform=${platform}`;
        return {
          version,
          source: manifest.source,
          runtime,
          downloadUrl,
          feedUrl,
        };
      }),
  };
}

export function createDesktopUpdater({
  source,
  currentVersion,
  native,
  prepareRuntime,
  restart,
  onStatus = () => {},
  downloadTimeout = 30 * 60 * 1000,
}) {
  let checking;
  let restarting;
  let ready;
  let disposed = false;
  const controller = new AbortController();
  const ignoreError = () => {};
  native?.on('error', ignoreError);
  return {
    get ready() {
      return ready;
    },
    check() {
      if (disposed) return Promise.reject(new Error('Nod is closing.'));
      if (restarting) return Promise.reject(new Error('Nod is restarting.'));
      if (checking) return checking;
      checking = (async () => {
        onStatus('checking');
        const candidate = await source.latest(currentVersion, controller.signal);
        if (!candidate) return ready;
        if (compareVersions(candidate.version, currentVersion) <= 0)
          throw new Error('The desktop update is not newer than this app.');
        if (ready && compareVersions(candidate.version, ready.version) <= 0) return ready;
        if (!native) ready = undefined;
        onStatus('preparing');
        await prepareRuntime(candidate, controller.signal, onStatus);
        controller.signal.throwIfAborted();
        ready = undefined;
        onStatus('downloading');
        if (native)
          await new Promise((resolve, reject) => {
            const finish = (error) => {
              native.removeListener('error', failed);
              native.removeListener('update-downloaded', downloaded);
              native.removeListener('update-not-available', unavailable);
              controller.signal.removeEventListener('abort', aborted);
              clearTimeout(timeout);
              error ? reject(error) : resolve();
            };
            const failed = (error) => finish(error);
            const downloaded = (_event, _notes, name) =>
              finish(
                name === `nod ${candidate.version}` || name === `Nod ${candidate.version}`
                  ? undefined
                  : new Error('The downloaded update does not match the selected version.'),
              );
            const unavailable = () =>
              finish(new Error('The selected desktop update is unavailable.'));
            const aborted = () => finish(new Error('Nod is closing.'));
            const timeout = setTimeout(
              () => finish(new Error('The desktop update download timed out.')),
              downloadTimeout,
            );
            timeout.unref?.();
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
      if (checking) return Promise.reject(new Error('A desktop update check is still running.'));
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

export function startDesktopUpdateChecks({
  check,
  powerMonitor,
  interval = 6 * 60 * 60 * 1000,
  retry = 15 * 60 * 1000,
}) {
  let timer;
  let failures = 0;
  let pending = false;
  let resumePending = false;
  let stopped = false;
  let due = 0;
  const run = async () => {
    if (stopped || pending) return;
    pending = true;
    clearTimeout(timer);
    try {
      await check();
      failures = 0;
    } catch {
      failures++;
    } finally {
      pending = false;
      const delay = resumePending
        ? 0
        : failures
          ? Math.min(interval, retry * 2 ** (failures - 1))
          : interval;
      resumePending = false;
      due = Date.now() + delay;
      if (!stopped) {
        timer = setTimeout(run, delay);
        timer.unref?.();
      }
    }
  };
  const resume = () => {
    if (Date.now() < due || stopped) return;
    if (pending) resumePending = true;
    else void run();
  };
  powerMonitor.on('resume', resume);
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    powerMonitor.removeListener('resume', resume);
  };
}
