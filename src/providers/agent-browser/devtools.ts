type FrameNode = {
  frame: { id: string; loaderId?: string; securityOrigin?: string };
  childFrames?: FrameNode[];
};
type Waiter = { resolve(value: unknown): void; reject(error: Error): void };
type DomNode = {
  backendNodeId: number;
  frameId?: string;
  shadowRootType?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
};
export type FocusedField = { origin: string; session: string; context: number };

const active = `(() => { if (!document.hasFocus()) return null; let node = document.activeElement; for (;;) { const root = node && (node.shadowRoot ?? (globalThis.__ottoRoots ?? []).find(root => root.host === node)); if (!root?.activeElement) break; node = root.activeElement; } return node && !['IFRAME', 'FRAME', 'BODY', 'HTML'].includes(node.tagName) ? node : null; })()`;
const focusScript = `(() => { const node = ${active}; globalThis.__ottoFocused = node; return node ? node.tagName : ''; })()`;
const blurScript = `(() => { const node = document.activeElement; if (node && node !== document.body && typeof node.blur === 'function') node.blur(); return ''; })()`;
const armScript = (privateValue: boolean) =>
  `(() => { const node = ${active}; if (!node || node !== globalThis.__ottoFocused) return ''; globalThis.__ottoField = node; if (${privateValue}) (globalThis.__ottoPrivateFields ??= new Set()).add(node); node.setAttribute('autocomplete', 'off'); if (node.tagName !== 'SELECT') { if (typeof node.select === 'function') node.select(); else document.execCommand('selectAll'); document.execCommand('delete'); } return node.tagName; })()`;
const maskScript = (on: boolean, secrets: string[], allFields: boolean, snapshot: boolean) =>
  `(() => {
    globalThis.__ottoMaskObserver?.disconnect();
    delete globalThis.__ottoMaskObserver;
    const privateFields = [...(globalThis.__ottoPrivateFields ?? [])].filter(node => node.isConnected);
    const types = globalThis.__ottoMaskedTypes ??= new Map();
    for (const [node, type] of types) if (type === null) node.removeAttribute('type'); else node.setAttribute('type', type);
    types.clear();
    const styles = globalThis.__ottoMaskedStyles ??= new Map();
    for (const [node, [hadStyle, properties]] of styles) {
      for (const [property, value, priority] of properties.slice().reverse()) {
        if (property === 'transition-property') getComputedStyle(node).opacity;
        if (value) node.style.setProperty(property, value, priority); else node.style.removeProperty(property);
      }
      if (!hadStyle && node.getAttribute('style') === '') node.removeAttribute('style');
    }
    styles.clear();
    if (!${on}) return '';
    const hide = node => {
      const property = ${snapshot} ? 'visibility' : 'opacity';
      if (!styles.has(node)) styles.set(node, [node.hasAttribute('style'), ['transition-property', property].map(name => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)])]);
      if (node.style.getPropertyValue('transition-property') !== 'none' || node.style.getPropertyPriority('transition-property') !== 'important') node.style.setProperty('transition-property', 'none', 'important');
      const value = ${snapshot} ? 'hidden' : '0';
      if (node.style.getPropertyValue(property) !== value || node.style.getPropertyPriority(property) !== 'important') node.style.setProperty(property, value, 'important');
    };
    const secrets = ${JSON.stringify(secrets)};
    const scan = ${allFields} || secrets.length;
    let roots = [];
    const apply = () => {
    roots = [...new Set([document, ...(scan ? globalThis.__ottoRoots ?? [] : []), ...privateFields.map(node => node.getRootNode())])];
    if (scan) for (let index = 0; index < roots.length; index++) for (const node of roots[index].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
    const numbers = secrets.filter(secret => /^\\d{12,19}$/.test(secret));
    const matches = value => typeof value === 'string' && (secrets.some(secret => value.includes(secret)) || numbers.some(secret => value.replace(/\\D/g, '').includes(secret)));
    for (const root of roots) {
      const fields = privateFields.filter(node => node.getRootNode() === root);
      for (const node of new Set([...(scan ? root.querySelectorAll('input,textarea,select') : []), ...fields])) {
        if (!${allFields} && !(fields.includes(node) && (node.value || node.textContent)) && !matches(node.value)) continue;
        if (${snapshot} && node.tagName === 'INPUT') {
          types.set(node, node.getAttribute('type'));
          node.setAttribute('type', 'password');
        } else hide(node);
      }
      if (secrets.length) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) if (matches(walk.currentNode.textContent) && walk.currentNode.parentElement) hide(walk.currentNode.parentElement);
      }
    }
    };
    apply();
    if (!${snapshot}) {
      const watch = () => roots.forEach(root => observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true }));
      const observer = new MutationObserver(() => { observer.disconnect(); apply(); watch(); });
      watch();
      globalThis.__ottoMaskObserver = observer;
    }
    return '';
  })()`;

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
  }).catch((error: unknown) => {
    socket.close();
    throw error;
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
      sessionId?: string;
      params?: {
        sessionId?: string;
        targetInfo?: { type?: string };
      };
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
  let page: string;
  try {
    ({ sessionId: page } = (await send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as {
      sessionId: string;
    });
    void follow(page);
    while (following.size) {
      const batch = [...following];
      following.clear();
      await Promise.all(batch);
    }
  } catch (error) {
    socket.close();
    throw error;
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
      { frameId, worldName: 'otto-private' },
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

  async function everyFrame(
    expression: string,
    shadows?: 'document' | 'focus',
    strict = Boolean(shadows),
  ) {
    const results: Array<FocusedField & { value: unknown }> = [];
    for (const session of [...sessions]) {
      const frames = await tree(session).catch((error) => {
        if (strict) throw error;
        return [];
      });
      const roots = new Map<string, number[]>();
      const walk = (node: DomNode, frame: string) => {
        if (node.shadowRootType === 'closed')
          roots.set(frame, [...(roots.get(frame) ?? []), node.backendNodeId]);
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])])
          walk(child, frame);
        if (node.contentDocument) walk(node.contentDocument, node.frameId ?? frame);
      };
      if (shadows === 'document' && frames.length) {
        const { root } = (await send('DOM.getDocument', { depth: -1, pierce: true }, session)) as {
          root: DomNode;
        };
        walk(root, frames[0]!.id);
      }
      for (const frame of frames) {
        try {
          const context = await world(session, frame.id);
          if (shadows === 'focus') {
            const { result } = (await send(
              'Runtime.evaluate',
              {
                contextId: context,
                expression: `globalThis.__ottoRoots = []; ${active}`,
                objectGroup: 'otto-roots',
              },
              session,
            )) as { result?: { objectId?: string } };
            if (result?.objectId) {
              const { node } = (await send(
                'DOM.describeNode',
                { objectId: result.objectId, depth: -1, pierce: true },
                session,
              )) as { node: DomNode };
              walk(node, frame.id);
            }
          }
          if (shadows) {
            const objects = await Promise.all(
              (roots.get(frame.id) ?? []).map(async (backendNodeId) => {
                const { object } = (await send(
                  'DOM.resolveNode',
                  { backendNodeId, executionContextId: context, objectGroup: 'otto-roots' },
                  session,
                )) as { object: { objectId: string } };
                return { objectId: object.objectId };
              }),
            );
            if (objects.length) {
              const { exceptionDetails } = await send(
                'Runtime.callFunctionOn',
                {
                  executionContextId: context,
                  functionDeclaration: 'function(...roots) { globalThis.__ottoRoots = roots; }',
                  arguments: objects,
                },
                session,
              );
              if (exceptionDetails) throw new Error('The page check failed.');
            } else if (shadows === 'document')
              await evaluate(session, context, 'globalThis.__ottoRoots = [];');
          }
          results.push({
            origin: frame.securityOrigin ?? '',
            session,
            context,
            value: await evaluate(session, context, expression),
          });
        } catch (error) {
          worlds.delete(`${session}:${frame.id}`);
          if (strict) throw error;
        }
      }
      if (shadows) await send('Runtime.releaseObjectGroup', { objectGroup: 'otto-roots' }, session);
    }
    if (strict && !results.length) throw new Error('The browser inspector is unavailable.');
    return results;
  }

  return {
    async readOnly(expression: string) {
      const { result, exceptionDetails } = (await send(
        'Runtime.evaluate',
        {
          expression,
          throwOnSideEffect: true,
          returnByValue: true,
          awaitPromise: true,
          timeout: 5000,
        },
        page,
      )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      return exceptionDetails ? undefined : { value: result?.value };
    },
    async scripted(mark = false) {
      const [main] = await tree(page);
      if (!main) throw new Error('The browser document is unavailable.');
      return (
        (await evaluate(
          page,
          await world(page, main.id),
          mark ? '(globalThis.__ottoScripted = true)' : 'Boolean(globalThis.__ottoScripted)',
        )) === true
      );
    },
    async focused(): Promise<FocusedField | undefined> {
      const hits = (await everyFrame(focusScript, 'focus')).filter((item) => item.value);
      if (hits.length !== 1) return undefined;
      const hit = hits[0]!;
      return { origin: hit.origin, session: hit.session, context: hit.context };
    },
    async blur() {
      await everyFrame(blurScript);
    },
    async mask(on: boolean, secrets: string[] = [], allFields = true, snapshot = false) {
      await everyFrame(
        maskScript(on, secrets, allFields, snapshot),
        on && (allFields || secrets.length) ? 'document' : undefined,
        true,
      );
    },
    async arm(field: FocusedField, privateValue = true) {
      return String((await evaluate(field.session, field.context, armScript(privateValue))) ?? '');
    },
    async insert(field: FocusedField, text: string) {
      return (
        (await evaluate(
          field.session,
          field.context,
          `(() => { const node = ${active}; if (!node || node !== globalThis.__ottoField || node.tagName === 'SELECT') return false; for (const character of ${JSON.stringify(text)}) if (!node.isConnected || ${active} !== node || !document.execCommand('insertText', false, character)) return false; return true; })()`,
        )) === true
      );
    },
    async code(field: FocusedField, selector: string, value: string) {
      return (
        (await evaluate(
          field.session,
          field.context,
          `(() => { const active = ${active}; const nodes = ${selector.startsWith('@') ? '[active]' : `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`}; if (!active || active !== globalThis.__ottoFocused || !nodes.includes(active) || !nodes.length || nodes.length > ${value.length}) return false; const values = nodes.length === 1 ? [${JSON.stringify(value)}] : Array.from(${JSON.stringify(value)}); if (nodes.length !== values.length) return false; for (let index = 0; index < nodes.length; index++) { const node = nodes[index]; (globalThis.__ottoPrivateFields ??= new Set()).add(node); node.setAttribute('autocomplete', 'off'); node.focus(); if (${active} !== node) return false; if (typeof node.select === 'function') node.select(); else document.execCommand('selectAll'); document.execCommand('delete'); for (const character of values[index]) { if (${active} !== node || !document.execCommand('insertText', false, character)) return false; } } return true; })()`,
        )) === true
      );
    },
    async choose(field: FocusedField, choices: string[]) {
      return (
        (await evaluate(
          field.session,
          field.context,
          `(() => { const node = ${active}; const choices = ${JSON.stringify(choices)}; if (!node || node !== globalThis.__ottoField || node.tagName !== 'SELECT') return false; const options = [...node.options]; const option = options.find((item) => choices.includes(item.value) || choices.includes(item.text.trim())) ?? options.find((item) => choices.some(choice => choice.toLocaleLowerCase() === item.value.toLocaleLowerCase() || choice.toLocaleLowerCase() === item.text.trim().toLocaleLowerCase())); if (!option) return false; node.value = option.value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
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
