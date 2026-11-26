import { mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const target = z.object({
  targetId: z.string(),
  type: z.string(),
  openerId: z.string().optional(),
});
const parent = z.object({ targetInfo: z.object({ parentFrameId: z.string().optional() }) });
const started = z.object({ guid: z.uuid(), frameId: z.string() });
const progress = z.object({
  guid: z.uuid(),
  state: z.enum(['inProgress', 'completed', 'canceled']),
});
const frameTree: z.ZodType<{ frame: { id: string }; childFrames?: unknown[] }> = z.lazy(() =>
  z.object({ frame: z.object({ id: z.string() }), childFrames: z.array(frameTree).optional() }),
);

export async function watchBrowser(options: {
  cdpUrl: string;
  incoming: string;
  initScript: string;
  closed: () => void;
  sessions: () => Array<{ root: string; directory: string }>;
}) {
  await rm(options.incoming, { recursive: true, force: true });
  await mkdir(options.incoming, { recursive: true, mode: 0o700 });
  const socket = new WebSocket(options.cdpUrl);
  await new Promise<void>((done, fail) => {
    socket.addEventListener('open', () => done(), { once: true });
    socket.addEventListener('error', () => fail(new Error('The browser channel is unavailable.')), {
      once: true,
    });
  });
  let next = 0;
  const replies = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  const send = (method: string, params: object, sessionId?: string) =>
    new Promise<Record<string, unknown>>((done, fail) => {
      const id = ++next;
      const timer = setTimeout(() => {
        replies.delete(id);
        fail(new Error(`The browser did not answer ${method}.`));
      }, 10_000);
      replies.set(id, (message) => {
        clearTimeout(timer);
        const reason = z.object({ message: z.string() }).safeParse(message.error).data?.message;
        if (message.error)
          fail(new Error(`The browser refused ${method}${reason ? `: ${reason}` : '.'}`));
        else done((message.result ?? {}) as Record<string, unknown>);
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  const pages = new Map<string, string | undefined>();
  const rootOf = (page: string) => {
    const roots = new Set(options.sessions().map((session) => session.root));
    let current: string | undefined = page;
    for (let depth = 0; current && depth < 20; depth++) {
      if (roots.has(current)) return current;
      current = pages.get(current);
    }
  };
  const frameIds = (tree: z.infer<typeof frameTree>): string[] => [
    tree.frame.id,
    ...(tree.childFrames ?? []).flatMap((child) => frameIds(frameTree.parse(child))),
  ];
  const attached = new Map<string, string>();
  const framesIn = async (page: string) => {
    const sessionId = attached.get(page);
    if (!sessionId) return [];
    return frameIds(frameTree.parse((await send('Page.getFrameTree', {}, sessionId)).frameTree));
  };
  const pageOf = async (frameId: string) => {
    let frame: string | undefined = frameId;
    for (let depth = 0; frame && depth < 8; depth++) {
      const current: string = frame;
      if (pages.has(current)) return current;
      for (const page of pages.keys())
        if (rootOf(page) && (await framesIn(page).catch((): string[] => [])).includes(current))
          return page;
      frame = parent.safeParse(
        await send('Target.getTargetInfo', { targetId: current }).catch(() => ({})),
      ).data?.targetInfo.parentFrameId;
    }
  };
  const directoryFor = async (frameId: string) => {
    const page = await pageOf(frameId);
    const root = page && rootOf(page);
    return options.sessions().find((session) => session.root === root)?.directory;
  };
  const downloads = new Map<string, Promise<string | undefined>>();
  const settle = async (guid: string, completed: boolean) => {
    const directory = completed ? await downloads.get(guid) : undefined;
    downloads.delete(guid);
    const file = resolve(options.incoming, guid);
    if (!directory) return rm(file, { force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rename(file, resolve(directory, guid));
  };
  const autoAttach = (sessionId?: string) =>
    send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
  const prepare = async (sessionId: string, type: unknown) => {
    const frame = type === 'page' || type === 'iframe';
    await Promise.allSettled([
      ...(frame
        ? [
            send('Page.enable', {}, sessionId),
            ...(type === 'page'
              ? [send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)]
              : []),
            send(
              'Page.addScriptToEvaluateOnNewDocument',
              { source: options.initScript, runImmediately: true },
              sessionId,
            ),
            autoAttach(sessionId),
          ]
        : []),
      send('Runtime.runIfWaitingForDebugger', {}, sessionId),
    ]);
  };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === 'number') {
      const reply = replies.get(message.id);
      replies.delete(message.id);
      if (typeof reply === 'function') reply(message);
    } else if (
      message.method === 'Target.targetCreated' ||
      message.method === 'Target.targetInfoChanged'
    ) {
      const info = target.safeParse(message.params?.targetInfo).data;
      if (info?.type === 'page') pages.set(info.targetId, info.openerId);
    } else if (message.method === 'Target.attachedToTarget') {
      const sessionId = String(message.params?.sessionId);
      const info = target.safeParse(message.params?.targetInfo).data;
      if (info) attached.set(info.targetId, sessionId);
      void prepare(sessionId, info?.type).catch(() => {});
    } else if (message.method === 'Target.detachedFromTarget') {
      const targetId = message.params?.targetId;
      if (typeof targetId === 'string') attached.delete(targetId);
    } else if (message.method === 'Target.targetDestroyed') {
      const gone = String(message.params?.targetId);
      for (const [page, opener] of pages) if (opener === gone) pages.set(page, pages.get(gone));
      pages.delete(gone);
    } else if (message.method === 'Browser.downloadWillBegin') {
      const download = started.safeParse(message.params).data;
      if (download)
        downloads.set(
          download.guid,
          directoryFor(download.frameId).catch(() => undefined),
        );
    } else if (message.method === 'Browser.downloadProgress') {
      const download = progress.safeParse(message.params).data;
      if (download && download.state !== 'inProgress')
        void settle(download.guid, download.state === 'completed').catch(() =>
          rm(resolve(options.incoming, download.guid), { force: true }),
        );
    }
  });
  let closing = false;
  socket.addEventListener('close', () => {
    for (const reply of replies.values()) reply({ error: 'closed' });
    replies.clear();
    if (!closing) options.closed();
  });
  try {
    await send('Target.setDiscoverTargets', { discover: true });
    await autoAttach();
    await send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: options.incoming,
      eventsEnabled: true,
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    open: () => socket.readyState === WebSocket.OPEN,
    close: () => {
      closing = true;
      socket.close();
    },
    tabs: (root: string) => [...pages.keys()].filter((page) => rootOf(page) === root),
    closeTab: (page: string) => send('Target.closeTarget', { targetId: page }),
    newWindow: async () =>
      String((await send('Target.createTarget', { url: 'about:blank', newWindow: true })).targetId),
  };
}
