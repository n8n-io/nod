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
export type BoundSignInControl = {
  backendNodeId: number;
  frameId: string;
  targetFrameId: string;
  loaderId: string;
  snapshot: string;
  controls: { role: string; name: string }[];
  origin: string;
  url: string;
  submits: { method: string; to: string } | null;
};
type FocusedField = { origin: string; session: string; context: number };
type ControlQuery = {
  selector?: string;
  point?: { x: number; y: number };
  pixel?: { x: number; y: number };
  focused?: boolean;
};

const active = `(() => { if (!document.hasFocus()) return null; let node = document.activeElement; for (;;) { const root = node && (node.shadowRoot ?? (globalThis.__nodRoots ?? []).find(root => root.host === node)); if (!root?.activeElement) break; node = root.activeElement; } return node && !['IFRAME', 'FRAME', 'BODY', 'HTML'].includes(node.tagName) ? node : null; })()`;
const focusScript = `(() => { const node = ${active}; globalThis.__nodFocused = node; return node ? node.tagName : ''; })()`;
const submitsScript = `function (enter) { const node = this.nodeType === 1 ? this : this.parentElement; const control = enter ? node : (node?.closest('button, input') ?? node?.closest('label')?.control); const form = control?.form; const button = ['submit', 'image'].includes(control?.type); if (!form || !(button || (enter && control.tagName === 'INPUT'))) return null; const own = (name) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get.call(form); const submitter = button ? control : [...own('elements')].find((element) => ['submit', 'image'].includes(element.type)); const method = (submitter?.hasAttribute('formmethod') ? submitter.formMethod : own('method')) || 'get'; if (method === 'dialog') return null; return { method: method.toUpperCase(), to: submitter?.hasAttribute('formaction') ? submitter.formAction : own('action') }; }`;
const signInControlSelector =
  'button, a[href], input[type="submit"], input[type="button"], input[type="image"], [role="button"], [role="link"]';
const signInSnapshot = `function () {
  if (!this.isConnected || this.ownerDocument !== document || !this.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) || this.matches(':disabled') || this.closest('[inert], [aria-disabled="true"], [aria-hidden="true"]')) return null;
  const rect = this.getBoundingClientRect();
  if (!rect.width || !rect.height || this.outerHTML.length > 16384) return null;
  const references = ['aria-labelledby', 'aria-describedby'].map(name => (this.getAttribute(name) ?? '').split(/\\s+/).map(id => document.getElementById(id)?.textContent ?? ''));
  return JSON.stringify({ origin: location.origin, url: location.href, html: this.outerHTML, href: this instanceof HTMLAnchorElement ? this.href : null, references, submits: (${submitsScript}).call(this, false) });
}`;
const blurScript = `(() => { const node = document.activeElement; if (node && node !== document.body && typeof node.blur === 'function') node.blur(); return ''; })()`;
const armScript = (privateValue: boolean) =>
  `(() => { const node = ${active}; if (!node || node !== globalThis.__nodFocused) return ''; globalThis.__nodField = node; if (${privateValue}) (globalThis.__nodPrivateFields ??= new Set()).add(node); node.setAttribute('autocomplete', 'off'); if (node.tagName !== 'SELECT') { if (typeof node.select === 'function') node.select(); else document.execCommand('selectAll'); document.execCommand('delete'); } return node.tagName; })()`;
const maskScript = (on: boolean, secrets: string[], allFields: boolean, snapshot: boolean) =>
  `(() => {
    globalThis.__nodMaskObserver?.disconnect();
    delete globalThis.__nodMaskObserver;
    const privateFields = [...(globalThis.__nodPrivateFields ?? [])].filter(node => node.isConnected);
    const types = globalThis.__nodMaskedTypes ??= new Map();
    for (const [node, type] of types) if (type === null) node.removeAttribute('type'); else node.setAttribute('type', type);
    types.clear();
    const styles = globalThis.__nodMaskedStyles ??= new Map();
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
    roots = [...new Set([document, ...(scan ? globalThis.__nodRoots ?? [] : []), ...privateFields.map(node => node.getRootNode())])];
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
      globalThis.__nodMaskObserver = observer;
    }
    return '';
  })()`;

export async function openDevtools(url: string, targetId: string, signal?: AbortSignal) {
  const address = new URL(url);
  if (address.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))
    throw new Error('The browser inspector must be local.');
  signal?.throwIfAborted();
  const socket = new WebSocket(url);
  let abort = () => {};
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The browser inspector is unavailable.')),
      10_000,
    );
    abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
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
  })
    .finally(() => signal?.removeEventListener('abort', abort))
    .catch((error: unknown) => {
      socket.close();
      throw error;
    });
  let next = 0;
  const pending = new Map<number, Waiter>();
  const sessions = new Set<string>();
  const following = new Set<Promise<unknown>>();
  const worlds = new Map<string, number>();
  const bindings = new Map<string, (payload: string) => void>();
  const send = (method: string, params: object = {}, sessionId?: string, cleanup = false) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!cleanup) signal?.throwIfAborted();
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
        name?: string;
        payload?: string;
        targetInfo?: { type?: string };
      };
    };
    const waiter = message.id === undefined ? undefined : pending.get(message.id);
    if (waiter) {
      pending.delete(message.id!);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'Inspector error.'));
      else waiter.resolve(message.result ?? {});
    } else if (message.method === 'Runtime.bindingCalled' && message.params?.name) {
      bindings.get(message.params.name)?.(message.params.payload ?? '');
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
      { frameId, worldName: 'nod-private' },
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
                expression: `globalThis.__nodRoots = []; ${active}`,
                objectGroup: 'nod-roots',
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
                  { backendNodeId, executionContextId: context, objectGroup: 'nod-roots' },
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
                  functionDeclaration: 'function(...roots) { globalThis.__nodRoots = roots; }',
                  arguments: objects,
                },
                session,
              );
              if (exceptionDetails) throw new Error('The page check failed.');
            } else if (shadows === 'document')
              await evaluate(session, context, 'globalThis.__nodRoots = [];');
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
      if (shadows) await send('Runtime.releaseObjectGroup', { objectGroup: 'nod-roots' }, session);
    }
    if (strict && !results.length) throw new Error('The browser inspector is unavailable.');
    return results;
  }

  const locate = async (query: ControlQuery, hitTest = false) => {
    let backendNodeId: number | undefined;
    let session = page;
    const describe = async (params: Record<string, unknown>) =>
      ((await send('DOM.describeNode', params, session)) as { node: { backendNodeId: number } })
        .node.backendNodeId;
    if (query.point || query.pixel) {
      const { cssVisualViewport: view } = (await send('Page.getLayoutMetrics', {}, page)) as {
        cssVisualViewport: { clientWidth: number; clientHeight: number };
      };
      const at = (value: number, size: number) =>
        Math.max(0, Math.min(Math.ceil(size) - 1, Math.round(value)));
      const x = at(query.pixel?.x ?? query.point!.x * view.clientWidth, view.clientWidth);
      const y = at(query.pixel?.y ?? query.point!.y * view.clientHeight, view.clientHeight);
      ({ backendNodeId } = (await send(
        'DOM.getNodeForLocation',
        { x, y, ignorePointerEventsNone: !hitTest },
        page,
      )) as { backendNodeId?: number });
      const owner = backendNodeId
        ? (
            (await send('DOM.describeNode', { backendNodeId }, page)) as {
              node: { nodeName: string; frameId?: string };
            }
          ).node
        : undefined;
      if (owner?.frameId && ['IFRAME', 'FRAME'].includes(owner.nodeName)) {
        for (const child of [...sessions].filter((item) => item !== page)) {
          if ((await tree(child).catch(() => []))[0]?.id !== owner.frameId) continue;
          const { model } = (await send('DOM.getBoxModel', { backendNodeId }, page)) as {
            model: { content: number[] };
          };
          const inner = (await send(
            'DOM.getNodeForLocation',
            {
              x: Math.round(x - model.content[0]!),
              y: Math.round(y - model.content[1]!),
              ignorePointerEventsNone: !hitTest,
            },
            child,
          ).catch(() => undefined)) as { backendNodeId?: number } | undefined;
          if (inner?.backendNodeId) {
            backendNodeId = inner.backendNodeId;
            session = child;
          }
          break;
        }
      }
    } else if (query.selector) {
      const { root } = (await send('DOM.getDocument', { depth: 0 }, page)) as {
        root: { nodeId: number };
      };
      const { nodeId } = (await send(
        'DOM.querySelector',
        { nodeId: root.nodeId, selector: query.selector },
        page,
      )) as { nodeId: number };
      if (nodeId) backendNodeId = await describe({ nodeId });
    } else if (query.focused) {
      const hits = (await everyFrame(focusScript, 'focus').catch(() => [])).filter(
        (item) => item.value,
      );
      const hit = hits.length === 1 ? hits[0]! : undefined;
      if (hit) {
        session = hit.session;
        const { result } = (await send(
          'Runtime.evaluate',
          {
            contextId: hit.context,
            expression: 'globalThis.__nodFocused',
            objectGroup: 'nod-control',
          },
          session,
        )) as { result?: { objectId?: string } };
        if (result?.objectId) backendNodeId = await describe({ objectId: result.objectId });
        await send('Runtime.releaseObjectGroup', { objectGroup: 'nod-control' }, session);
      }
      const [main] = backendNodeId ? [] : await tree(page);
      if (main) {
        session = page;
        const { result } = (await send(
          'Runtime.evaluate',
          {
            contextId: await world(page, main.id),
            expression:
              '(() => { let node = document.activeElement; while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement; return node === document.body && !node.isContentEditable ? null : node; })()',
            objectGroup: 'nod-control',
          },
          page,
        )) as { result?: { objectId?: string } };
        if (result?.objectId) backendNodeId = await describe({ objectId: result.objectId });
        await send('Runtime.releaseObjectGroup', { objectGroup: 'nod-control' }, page);
      }
    }
    return backendNodeId ? { backendNodeId, session } : undefined;
  };

  const formOf = async (found: { backendNodeId: number; session: string }, enter: boolean) => {
    const [frame] = await tree(found.session);
    if (!frame) throw new Error('The control is not in an open frame.');
    const { object } = (await send(
      'DOM.resolveNode',
      {
        backendNodeId: found.backendNodeId,
        executionContextId: await world(found.session, frame.id),
        objectGroup: 'nod-control',
      },
      found.session,
    )) as { object: { objectId: string } };
    try {
      const { result, exceptionDetails } = (await send(
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration: submitsScript,
          arguments: [{ value: enter }],
          returnByValue: true,
        },
        found.session,
      )) as {
        result?: { value?: { method?: unknown; to?: unknown } | null };
        exceptionDetails?: unknown;
      };
      if (exceptionDetails) throw new Error('The control could not be inspected.');
      const value = result?.value;
      return typeof value?.method === 'string' && typeof value.to === 'string'
        ? { method: value.method, to: value.to }
        : null;
    } finally {
      await send('Runtime.releaseObjectGroup', { objectGroup: 'nod-control' }, found.session);
    }
  };

  const signInSelector = async (selector: string) => {
    const seen = new Set<string>();
    let found: { backendNodeId: number; session: string } | undefined;
    for (const session of [...sessions].reverse()) {
      for (const frame of await tree(session)) {
        if (seen.has(frame.id)) continue;
        seen.add(frame.id);
        const { result, exceptionDetails } = (await send(
          'Runtime.evaluate',
          {
            contextId: await world(session, frame.id),
            expression: `(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); if (nodes.length > 1) throw new Error('Ambiguous sign-in control'); return nodes[0] ?? null; })()`,
            objectGroup: 'nod-sign-in',
          },
          session,
        )) as { result?: { objectId?: string }; exceptionDetails?: unknown };
        if (exceptionDetails || (result?.objectId && found))
          throw new Error('The sign-in selector must identify one control.');
        if (result?.objectId) {
          const { node } = (await send(
            'DOM.describeNode',
            { objectId: result.objectId },
            session,
          )) as {
            node: { backendNodeId: number };
          };
          found = { backendNodeId: node.backendNodeId, session };
        }
        await send('Runtime.releaseObjectGroup', { objectGroup: 'nod-sign-in' }, session);
      }
    }
    return found;
  };

  const controlsFor = async (found: { backendNodeId: number; session: string }) => {
    const { backendNodeId, session } = found;
    const { nodes } = (await send(
      'Accessibility.getPartialAXTree',
      { backendNodeId, fetchRelatives: true },
      session,
    )) as {
      nodes: Array<{
        nodeId: string;
        parentId?: string;
        ignored?: boolean;
        backendDOMNodeId?: number;
        role?: { value?: unknown };
        name?: { value?: unknown };
      }>;
    };
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const controls: Array<{ role: string; name: string }> = [];
    for (
      let node = nodes.find((item) => item.backendDOMNodeId === backendNodeId);
      node && controls.length < 3;
      node = node.parentId ? byId.get(node.parentId) : undefined
    ) {
      const name = String(node.name?.value ?? '').trim();
      if (!node.ignored && name) controls.push({ role: String(node.role?.value ?? ''), name });
    }
    return controls;
  };

  const controlTarget = async (query: ControlQuery) => {
    const found = await locate(query);
    const [frame] = found ? await tree(found.session) : [];
    return found && frame?.loaderId
      ? {
          identity: {
            frame: frame.id,
            document: frame.loaderId,
            backendNodeId: found.backendNodeId,
          },
          controls: await controlsFor(found),
        }
      : undefined;
  };

  const resolveControl = async (backendNodeId: number, session: string, frameId: string) => {
    const { object } = (await send(
      'DOM.resolveNode',
      {
        backendNodeId,
        executionContextId: await world(session, frameId),
        objectGroup: 'nod-sign-in',
      },
      session,
    )) as { object: { objectId?: string } };
    if (!object.objectId) throw new Error('The sign-in control is no longer available.');
    return object.objectId;
  };

  const controlSnapshot = async (objectId: string, session: string) => {
    const { result, exceptionDetails } = (await send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: signInSnapshot,
        returnByValue: true,
      },
      session,
    )) as { result?: { value?: string | null }; exceptionDetails?: unknown };
    if (exceptionDetails || !result?.value)
      throw new Error('The sign-in control is no longer available.');
    return result.value;
  };

  return {
    async copySelection(): Promise<string | undefined> {
      const { browserContextId } = (await send('Target.createBrowserContext', {
        disposeOnDetach: true,
      })) as { browserContextId: string };
      try {
        const { targetId: trustedTarget } = (await send('Target.createTarget', {
          url: 'chrome://newtab/',
          browserContextId,
          background: true,
        })) as { targetId: string };
        const { sessionId: trusted } = (await send('Target.attachToTarget', {
          targetId: trustedTarget,
          flatten: true,
        })) as { sessionId: string };
        await send('Emulation.setFocusEmulationEnabled', { enabled: true }, trusted);
        const trustedEvaluate = async (expression: string, cleanup = false) => {
          const { result, exceptionDetails } = (await send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            trusted,
            cleanup,
          )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
          if (exceptionDetails) throw new Error('The browser clipboard is unavailable.');
          return result?.value;
        };
        const origin = await trustedEvaluate('location.origin');
        if (origin !== 'chrome://newtab' && origin !== 'chrome://new-tab-page')
          throw new Error('The browser clipboard is unavailable.');
        await send('Browser.grantPermissions', {
          browserContextId,
          origin,
          permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        });
        const modifier =
          (await trustedEvaluate("navigator.platform.startsWith('Mac')")) === true ? 4 : 2;
        const prepared = await trustedEvaluate(`(async () => {
          let previousItems;
          try {
            previousItems = await Promise.all((await navigator.clipboard.read()).map(async item => {
              if (!item.types.every(type => ClipboardItem.supports(type))) throw new Error('Unsupported clipboard data');
              const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
              return new ClipboardItem(Object.fromEntries(entries));
            }));
          } catch {}
          let previousText;
          try {
            previousText = await navigator.clipboard.readText();
          } catch (error) {
            if (error?.name !== 'NotFoundError') throw error;
            previousText = '';
          }
          const restorable = Boolean(previousItems?.length) &&
            (!previousText || previousItems.some(item => item.types.includes('text/plain')));
          if (previousText && !restorable) throw new Error('Clipboard snapshot unavailable');
          const marker = restorable ? crypto.randomUUID() : null;
          globalThis.__nodClipboard = { previousText, previousItems, marker };
          return { mark: Boolean(marker), restorable };
        })()`);
        if (
          !prepared ||
          typeof prepared !== 'object' ||
          !('mark' in prepared) ||
          typeof prepared.mark !== 'boolean' ||
          !('restorable' in prepared) ||
          typeof prepared.restorable !== 'boolean'
        )
          throw new Error('The browser clipboard is unavailable.');
        let restore = prepared.restorable;
        try {
          if (prepared.mark) {
            if (
              (await trustedEvaluate(
                'navigator.clipboard.writeText(globalThis.__nodClipboard.marker).then(() => true)',
              )) !== true
            )
              throw new Error('The browser clipboard is unavailable.');
          }
          const key = {
            key: 'c',
            code: 'KeyC',
            windowsVirtualKeyCode: 67,
            modifiers: modifier,
          };
          try {
            await send(
              'Input.dispatchKeyEvent',
              { ...key, type: 'keyDown', commands: ['copy'] },
              page,
            );
          } finally {
            await send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' }, page, true);
          }
          const outcome = await trustedEvaluate(`(async () => {
            let text;
            try {
              text = await navigator.clipboard.readText();
            } catch (error) {
              if (error?.name !== 'NotFoundError') throw error;
              text = '';
            }
            const { previousText, marker } = globalThis.__nodClipboard;
            if (!text || (marker ? text === marker : text === previousText)) return { status: 'unchanged' };
            if (text.length > 262144) return { status: 'too_large' };
            return { status: 'copied', text };
          })()`);
          if (!outcome || typeof outcome !== 'object' || !('status' in outcome))
            throw new Error('The browser clipboard is unavailable.');
          if (outcome.status === 'too_large') throw new Error('The copied text is too long.');
          if (outcome.status === 'unchanged') {
            if (!prepared.mark) restore = false;
            return undefined;
          }
          if (
            outcome.status !== 'copied' ||
            !('text' in outcome) ||
            typeof outcome.text !== 'string'
          )
            throw new Error('The browser clipboard is unavailable.');
          signal?.throwIfAborted();
          return outcome.text;
        } finally {
          if (
            restore &&
            (await trustedEvaluate(
              'navigator.clipboard.write(globalThis.__nodClipboard.previousItems).then(() => true)',
              true,
            )) !== true
          )
            throw new Error('The browser clipboard could not be restored.');
        }
      } finally {
        await send('Target.disposeBrowserContext', { browserContextId }, undefined, true);
      }
    },
    async readOnly(expression: string) {
      const { result, exceptionDetails } = (await send(
        'Runtime.evaluate',
        {
          expression,
          throwOnSideEffect: true,
          returnByValue: true,
          awaitPromise: false,
          timeout: 5000,
        },
        page,
      )) as { result?: { subtype?: string; value?: unknown }; exceptionDetails?: unknown };
      if (exceptionDetails || result?.subtype === 'promise') return undefined;
      return { value: result?.value };
    },
    async navigation() {
      const { currentIndex, entries } = (await send('Page.getNavigationHistory', {}, page)) as {
        currentIndex: number;
        entries: Array<{ transitionType?: string; url?: string }>;
      };
      return { type: entries[currentIndex]?.transitionType, url: entries[currentIndex]?.url };
    },
    async scripted(mark = false) {
      const [main] = await tree(page);
      if (!main) throw new Error('The browser document is unavailable.');
      return (
        (await evaluate(
          page,
          await world(page, main.id),
          mark ? '(globalThis.__nodScripted = true)' : 'Boolean(globalThis.__nodScripted)',
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
    async holding() {
      return (
        await everyFrame(
          `[...(globalThis.__nodPrivateFields ?? [])].some(node => node.isConnected && (node.value || (node.isContentEditable && node.textContent)))`,
          undefined,
          true,
        )
      ).some((item) => item.value === true);
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
          `(() => { const node = ${active}; if (!node || node !== globalThis.__nodField || node.tagName === 'SELECT') return false; for (const character of ${JSON.stringify(text)}) if (!node.isConnected || ${active} !== node || !document.execCommand('insertText', false, character)) return false; return true; })()`,
        )) === true
      );
    },
    async code(field: FocusedField, selector: string, value: string) {
      return (
        (await evaluate(
          field.session,
          field.context,
          `(() => { const active = ${active}; const nodes = ${selector.startsWith('@') ? '[active]' : `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`}; if (!active || active !== globalThis.__nodFocused || !nodes.includes(active) || !nodes.length || nodes.length > ${value.length}) return false; const values = nodes.length === 1 ? [${JSON.stringify(value)}] : Array.from(${JSON.stringify(value)}); if (nodes.length !== values.length) return false; for (let index = 0; index < nodes.length; index++) { const node = nodes[index]; (globalThis.__nodPrivateFields ??= new Set()).add(node); node.setAttribute('autocomplete', 'off'); node.focus(); if (${active} !== node) return false; if (typeof node.select === 'function') node.select(); else document.execCommand('selectAll'); document.execCommand('delete'); for (const character of values[index]) { if (${active} !== node || !document.execCommand('insertText', false, character)) return false; } } return true; })()`,
        )) === true
      );
    },
    async choose(field: FocusedField, choices: string[]) {
      return (
        (await evaluate(
          field.session,
          field.context,
          `(() => { const node = ${active}; const choices = ${JSON.stringify(choices)}; if (!node || node !== globalThis.__nodField || node.tagName !== 'SELECT') return false; const options = [...node.options]; const option = options.find((item) => choices.includes(item.value) || choices.includes(item.text.trim())) ?? options.find((item) => choices.some(choice => choice.toLocaleLowerCase() === item.value.toLocaleLowerCase() || choice.toLocaleLowerCase() === item.text.trim().toLocaleLowerCase())); if (!option) return false; node.value = option.value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
        )) === true
      );
    },
    target: controlTarget,
    async controls(query: ControlQuery) {
      return (await controlTarget(query))?.controls ?? [];
    },
    async signInControl(query: ControlQuery): Promise<BoundSignInControl> {
      const found = query.selector ? await signInSelector(query.selector) : await locate(query);
      if (!found) throw new Error('The sign-in control could not be found.');
      try {
        const frames = await tree(found.session);
        let frame: FrameNode['frame'] | undefined;
        let objectId: string | undefined;
        for (const candidate of frames) {
          const resolved = await resolveControl(found.backendNodeId, found.session, candidate.id);
          const { result } = (await send(
            'Runtime.callFunctionOn',
            {
              objectId: resolved,
              functionDeclaration: 'function () { return this.ownerDocument === document; }',
              returnByValue: true,
            },
            found.session,
          )) as { result?: { value?: boolean } };
          if (result?.value === true) {
            frame = candidate;
            objectId = resolved;
            break;
          }
        }
        if (!frame?.loaderId || !objectId)
          throw new Error('The sign-in document is no longer available.');
        const { result, exceptionDetails } = (await send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: `function () { return (this.nodeType === 1 ? this : this.parentElement)?.closest(${JSON.stringify(signInControlSelector)}); }`,
            objectGroup: 'nod-sign-in',
          },
          found.session,
        )) as { result?: { objectId?: string }; exceptionDetails?: unknown };
        if (exceptionDetails || !result?.objectId)
          throw new Error('The sign-in control is not available.');
        const { node } = (await send(
          'DOM.describeNode',
          { objectId: result.objectId },
          found.session,
        )) as { node: { backendNodeId: number } };
        const snapshot = await controlSnapshot(result.objectId, found.session);
        const controls = await controlsFor({
          backendNodeId: node.backendNodeId,
          session: found.session,
        });
        if (
          !controls[0]?.name ||
          !['button', 'link'].includes(controls[0].role) ||
          (await controlSnapshot(result.objectId, found.session)) !== snapshot
        )
          throw new Error('The sign-in control changed during inspection.');
        const details = JSON.parse(snapshot) as {
          origin: string;
          url: string;
          submits: { method: string; to: string } | null;
        };
        return {
          backendNodeId: node.backendNodeId,
          frameId: frame.id,
          targetFrameId: frames[0]!.id,
          loaderId: frame.loaderId,
          snapshot,
          controls,
          origin: details.origin,
          url: details.url,
          submits: details.submits,
        };
      } finally {
        await send('Runtime.releaseObjectGroup', { objectGroup: 'nod-sign-in' }, found.session);
      }
    },
    async selectSignInControl(control: BoundSignInControl) {
      let session: string | undefined;
      for (const candidate of sessions) {
        const frames = await tree(candidate);
        if (
          frames[0]?.id === control.targetFrameId &&
          frames.some(
            (frame) => frame.id === control.frameId && frame.loaderId === control.loaderId,
          )
        ) {
          session = candidate;
          break;
        }
      }
      if (!session) throw new Error('The sign-in document changed.');
      const name = `nodSignIn${crypto.randomUUID().replaceAll('-', '')}`;
      let pressed = false;
      let outcome: boolean | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let context: number | undefined;
      try {
        const objectId = await resolveControl(control.backendNodeId, session, control.frameId);
        context = await world(session, control.frameId);
        await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: control.backendNodeId }, session);
        const { quads } = (await send(
          'DOM.getContentQuads',
          { backendNodeId: control.backendNodeId },
          session,
        )) as { quads: number[][] };
        const quad = quads.find((value) => value.length === 8 && value.every(Number.isFinite));
        if (!quad) throw new Error('The sign-in control is no longer visible.');
        const point = {
          x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
          y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
        };
        if (session !== page) {
          const { backendNodeId } = (await send(
            'DOM.getFrameOwner',
            { frameId: control.targetFrameId },
            page,
          )) as { backendNodeId: number };
          const { model } = (await send('DOM.getBoxModel', { backendNodeId }, page)) as {
            model: { content: number[]; border: number[]; width: number; height: number };
          };
          const content = model.content;
          if (
            content[1] !== content[3] ||
            content[0] !== content[6] ||
            content[2] !== content[4] ||
            content[5] !== content[7] ||
            model.border[2]! - model.border[0]! !== model.width ||
            model.border[5]! - model.border[1]! !== model.height
          )
            throw new Error('The sign-in frame could not be located safely.');
          point.x += content[0]!;
          point.y += content[1]!;
        }
        const check = async () => {
          if (
            (await controlSnapshot(objectId, session!)) !== control.snapshot ||
            JSON.stringify(
              await controlsFor({ backendNodeId: control.backendNodeId, session: session! }),
            ) !== JSON.stringify(control.controls)
          )
            throw new Error('The sign-in control changed.');
          const hit = await locate({ pixel: point }, true);
          if (!hit || hit.session !== session) throw new Error('The sign-in control is covered.');
          const hitId = await resolveControl(hit.backendNodeId, session!, control.frameId);
          const { result, exceptionDetails } = (await send(
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: 'function (hit) { return this === hit || this.contains(hit); }',
              arguments: [{ objectId: hitId }],
              returnByValue: true,
            },
            session,
          )) as { result?: { value?: boolean }; exceptionDetails?: unknown };
          if (exceptionDetails || result?.value !== true)
            throw new Error('The sign-in control is covered.');
        };
        await check();
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, page);
        await check();
        await send('Runtime.enable', {}, session);
        await send('Runtime.addBinding', { name, executionContextId: context }, session);
        const clicked = new Promise<boolean>((resolve) => {
          bindings.set(name, (payload) => {
            outcome = payload === 'accepted';
            resolve(outcome);
          });
          timer = setTimeout(() => resolve(false), 5000);
        });
        await send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: `function (name, expected) {
            const node = this;
            const guard = event => {
              const valid = event.isTrusted && event.composedPath().includes(node) && (${signInSnapshot}).call(node) === expected;
              if (!valid) { event.preventDefault(); event.stopImmediatePropagation(); }
              if (!valid || event.type === 'click') globalThis[name](valid ? 'accepted' : 'changed');
            };
            globalThis[name + 'Guard'] = guard;
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.addEventListener(type, guard, true);
          }`,
            arguments: [{ value: name }, { value: control.snapshot }],
          },
          session,
        );
        pressed = true;
        await send(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 },
          page,
        );
        if (outcome === false) throw new Error('The sign-in control changed.');
        await check();
        await send(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 },
          page,
        );
        pressed = false;
        if (!(await clicked)) throw new Error('The sign-in control did not receive the click.');
      } finally {
        if (pressed)
          await send(
            'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0 },
            page,
            true,
          ).catch(() => {});
        clearTimeout(timer);
        bindings.delete(name);
        if (context !== undefined)
          await send(
            'Runtime.evaluate',
            {
              contextId: context,
              expression: `(() => { const name = ${JSON.stringify(name)}; const guard = globalThis[name + 'Guard']; for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.removeEventListener(type, guard, true); delete globalThis[name + 'Guard']; })()`,
            },
            session,
            true,
          ).catch(() => {});
        await send('Runtime.removeBinding', { name }, session, true).catch(() => {});
        await send(
          'Runtime.releaseObjectGroup',
          { objectGroup: 'nod-sign-in' },
          session,
          true,
        ).catch(() => {});
      }
    },
    async submits(query: ControlQuery, enter: boolean) {
      const target = await locate(query);
      if (target) return formOf(target, enter);
      if (query.focused) return null;
      throw new Error('The control could not be found.');
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
