import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, shell } from 'electron';
import { createArtifactFiles, canOpenArtifact } from './artifact-files.mjs';

export function registerArtifactFileHandlers({ isEngine, origin, headers, window, icon }) {
  const attached = new WeakSet();
  function attach(contents) {
    if (attached.has(contents)) return;
    attached.add(contents);
    contents.on('context-menu', (_event, params) => {
      if (!params.frame || !isEngine({ sender: contents, senderFrame: params.frame })) return;
      const roles = params.isEditable
        ? ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']
        : params.selectionText
          ? ['copy', 'selectAll']
          : [];
      const linkURL = typeof params.linkURL === 'string' ? params.linkURL : '';
      if (!roles.length && !linkURL) return;
      const entries = roles.map((role) => ({
        role,
        enabled:
          params.editFlags[`can${role[0].toUpperCase()}${role.slice(1)}`] !== false &&
          !(params.formControlType === 'input-password' && ['copy', 'cut'].includes(role)),
      }));
      const suggestions = (params.dictionarySuggestions ?? []).slice(0, 5).map((word) => ({
        label: word,
        click: () => {
          if (isEngine({ sender: contents, senderFrame: params.frame }))
            contents.replaceMisspelling(word);
        },
      }));
      const linkEntries = linkURL
        ? [
            ...(suggestions.length || entries.length ? [{ type: 'separator' }] : []),
            {
              label: 'Copy link address',
              click: () => {
                if (isEngine({ sender: contents, senderFrame: params.frame }))
                  clipboard.writeText(linkURL);
              },
            },
          ]
        : [];
      Menu.buildFromTemplate([...suggestions, ...entries, ...linkEntries]).popup({
        window: BrowserWindow.fromWebContents(contents),
      });
    });
  }
  if (window()) attach(window().webContents);
  app.on('web-contents-created', (_event, contents) => attach(contents));
  const artifactFiles = createArtifactFiles({
    temporary: app.getPath('temp'),
    downloads: app.getPath('downloads'),
    fetchArtifact: (id, signal) => {
      if (!window() || !origin()) throw new Error('The workspace is unavailable.');
      return fetch(`${origin()}/api/artifacts/${id}`, {
        redirect: 'error',
        headers: headers(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
    },
  });
  ipcMain.handle('nod:file:action', async (event, id, action) => {
    if (!isEngine(event) || !['prepare', 'drag', 'save', 'open', 'show'].includes(action))
      throw new Error('This action is unavailable.');
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    )
      throw new Error('This file is unavailable.');
    const access = await fetch(`${origin()}/api/artifacts/${id}/metadata`, {
      redirect: 'error',
      headers: headers(),
      signal: AbortSignal.timeout(10000),
    });
    await access.arrayBuffer();
    if (!access.ok || !isEngine(event)) throw new Error('This file is no longer available.');
    if (action === 'save') return artifactFiles.save(id);
    if (action === 'prepare') {
      await artifactFiles.prepare(id);
      return;
    }
    const file = await artifactFiles.path(id);
    if (!isEngine(event)) throw new Error('This action is unavailable.');
    if (action === 'drag')
      event.sender.startDrag({
        file: file.path,
        icon: nativeImage.createFromPath(icon).resize({ width: 64, height: 64 }),
      });
    if (action === 'show') shell.showItemInFolder(file.path);
    if (action === 'open') {
      if (!canOpenArtifact(file)) throw new Error('Save this file and open it from Downloads.');
      const failure = await shell.openPath(file.path);
      if (failure) throw new Error('The file could not be opened.');
    }
  });
  ipcMain.handle('nod:file:menu', (event, id, image) => {
    if (
      !isEngine(event) ||
      typeof id !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(id) ||
      typeof image !== 'boolean'
    )
      throw new Error('This action is unavailable.');
    return new Promise((resolve) => {
      let chosen = null;
      const entries = [
        { label: 'Use in message', value: 'reuse' },
        ...(image ? [{ label: 'Copy image', value: 'copy' }] : []),
        { label: 'Save to Downloads', value: 'save' },
        { label: 'Open', value: 'open' },
        { label: 'Show in folder', value: 'show' },
      ];
      Menu.buildFromTemplate(
        entries.map(({ label, value }) => ({
          label,
          click: () => {
            chosen = value;
          },
        })),
      ).popup({
        window: BrowserWindow.fromWebContents(event.sender),
        callback: () => resolve(chosen),
      });
    });
  });
  return () => artifactFiles.dispose();
}
