type FrameNode = {
  frame: { id: string; loaderId?: string; securityOrigin?: string };
  childFrames?: FrameNode[];
};
type Waiter = { resolve(value: unknown): void; reject(error: Error): void };
export type FocusedField = { origin: string; session: string; context: number };

const active = `(() => { let node = document.activeElement; while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement; return node && !['IFRAME', 'FRAME', 'BODY', 'HTML'].includes(node.tagName) ? node : null; })()`;
const focusScript = `(() => { const node = ${active}; return node ? node.tagName : ''; })()`;
const blurScript = `(() => { const node = document.activeElement; if (node && node !== document.body && typeof node.blur === 'function') node.blur(); return ''; })()`;
const armScript = `(() => { const node = ${active}; if (!node) return ''; globalThis.__ottoField = node; node.setAttribute('autocomplete', 'off'); if (node.tagName !== 'SELECT') { if (typeof node.select === 'function') node.select(); else document.execCommand('selectAll'); document.execCommand('delete'); } return node.tagName; })()`;
const maskScript = (on: boolean) =>
  `(() => { const roots = [document]; for (let index = 0; index < roots.length; index++) for (const node of roots[index].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot); for (const root of roots) { root.querySelector('style[data-otto-mask]')?.remove(); if (${on}) { const style = document.createElement('style'); style.dataset.ottoMask = ''; style.textContent = 'input,textarea,select,[contenteditable]{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}'; (root === document ? document.documentElement : root).append(style); } } return ''; })()`;

export async function openDevtools(url: string, targetId: string) {
  const address = new URL(url);
  if (address.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname))
    throw new Error('The browser inspector must be local.');
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The browser inspector is unavailable.')),
      10_000,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('The browser inspector is unavailable.'));
      },
      { once: true },
    );
  });
  let next = 0;
  const pending = new Map<number, Waiter>();
  const sessions = new Set<string>();
  const following = new Set<Promise<unknown>>();
  const worlds = new Map<string, number>();
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The browser inspector did not answer.'));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as Record<string, unknown>);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const follow = (sessionId: string) => {
    sessions.add(sessionId);
    const followed = send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    ).catch(() => {});
    following.add(followed);
    return followed;
  };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: { sessionId?: string; targetInfo?: { type?: string } };
    };
    const waiter = message.id === undefined ? undefined : pending.get(message.id);
    if (waiter) {
      pending.delete(message.id!);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'Inspector error.'));
      else waiter.resolve(message.result ?? {});
    } else if (
      message.method === 'Target.attachedToTarget' &&
      message.params?.targetInfo?.type === 'iframe' &&
      message.params.sessionId
    )
      void follow(message.params.sessionId);
    else if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId) {
      sessions.delete(message.params.sessionId);
      for (const key of worlds.keys())
        if (key.startsWith(`${message.params.sessionId}:`)) worlds.delete(key);
    }
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values())
      waiter.reject(new Error('The browser inspector closed.'));
    pending.clear();
  });
  const { sessionId: page } = (await send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as {
    sessionId: string;
  };
  void follow(page);
  while (following.size) {
    const batch = [...following];
    following.clear();
    await Promise.all(batch);
  }

  const tree = async (session: string) => {
    const frames: FrameNode['frame'][] = [];
    const walk = (node: FrameNode) => {
      frames.push(node.frame);
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk((await send('Page.getFrameTree', {}, session)).frameTree as FrameNode);
    return frames;
  };
  const world = async (session: string, frameId: string) => {
    const key = `${session}:${frameId}`;
    const known = worlds.get(key);
    if (known !== undefined) return known;
    const { executionContextId } = (await send(
      'Page.createIsolatedWorld',
      { frameId, worldName: 'otto-card' },
      session,
    )) as { executionContextId: number };
    worlds.set(key, executionContextId);
    return executionContextId;
  };
  const evaluate = async (session: string, context: number, expression: string) => {
    const { result, exceptionDetails } = (await send(
      'Runtime.evaluate',
      { contextId: context, expression, returnByValue: true },
      session,
    )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (exceptionDetails) throw new Error('The page check failed.');
    return result?.value;
  };

  async function everyFrame(expression: string) {
    const results: Array<FocusedField & { value: unknown }> = [];
    for (const session of [...sessions]) {
      const frames = await tree(session).catch(() => []);
      for (const frame of frames) {
        try {
          const context = await world(session, frame.id);
          results.push({
            origin: frame.securityOrigin ?? '',
            session,
            context,
            value: await evaluate(session, context, expression),
          });
        } catch {
          worlds.delete(`${session}:${frame.id}`);
        }
      }
    }
    return results;
  }

  return {
    async focused(): Promise<FocusedField | undefined> {
      const hits = (await everyFrame(focusScript)).filter((item) => item.value);
      if (hits.length !== 1) return undefined;
      const hit = hits[0]!;
      return { origin: hit.origin, session: hit.session, context: hit.context };
    },
    async blur() {
      await everyFrame(blurScript);
    },
    async mask(on: boolean) {
      await everyFrame(maskScript(on));
    },
    async arm(field: FocusedField) {
      return String((await evaluate(field.session, field.context, armScript)) ?? '');
    },
    async insert(field: FocusedField, text: string) {
      return (
        (await evaluate(
          field.session,
          field.context,
          `(() => { const node = ${active}; return Boolean(node) && node === globalThis.__ottoField && node.tagName !== 'SELECT' && document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`,
        )) === true
      );
    },
    async choose(field: FocusedField, choices: string[]) {
      return (
        (await evaluate(
          field.session,
          field.context,
          `(() => { const node = ${active}; const choices = ${JSON.stringify(choices)}; if (!node || node !== globalThis.__ottoField || node.tagName !== 'SELECT') return false; const option = [...node.options].find((item) => choices.includes(item.value) || choices.includes(item.text.trim())); if (!option) return false; node.value = option.value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
        )) === true
      );
    },
    async document() {
      const [main] = await tree(page);
      if (!main?.loaderId) throw new Error('The checkout page could not be identified.');
      return main.loaderId;
    },
    async alive(loaderId: string) {
      const { targetInfos } = (await send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; type: string }>;
      };
      for (const target of targetInfos.filter((item) => item.type === 'page')) {
        const { sessionId } = (await send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        })) as { sessionId: string };
        const [main] = await tree(sessionId);
        if (main?.loaderId === loaderId) return true;
      }
      return false;
    },
    close() {
      socket.close();
    },
  };
}
