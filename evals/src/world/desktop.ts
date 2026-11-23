import { createHash } from 'node:crypto';
import type { DesktopControl, DesktopRequest } from '../../../src/ports/desktop.ts';

export interface DesktopElement {
  role: string;
  name?: string;
  value?: string;
  secure?: boolean;
  press?: () => void;
  children?: DesktopElement[];
}

export interface DesktopWindow {
  id: string;
  title: string;
  root: DesktopElement;
}

export interface DesktopApp {
  bundle: string;
  name: string;
  running: boolean;
  windows: DesktopWindow[];
  menu?: Record<string, Record<string, () => void>>;
}

export interface DesktopStep {
  op: string;
  bundle?: string;
  target?: string;
  text?: string;
}

export type FakeDesktop = DesktopControl & {
  apps: DesktopApp[];
  steps: DesktopStep[];
  requests: DesktopRequest[];
  app(bundle: string): DesktopApp;
};

const textRoles = new Set(['textfield', 'textarea']);

export function createDesktop(apps: DesktopApp[]): FakeDesktop {
  const steps: DesktopStep[] = [];
  const requests: DesktopRequest[] = [];
  const menuElements = new WeakSet<DesktopElement>();
  const pids = new Map(apps.map((app, index) => [app.bundle, 500 + index]));
  const refs = new Map<string, { app: DesktopApp; element: DesktopElement }>();
  let snapshots = 0;
  const info = (app: DesktopApp) => ({
    pid: pids.get(app.bundle),
    bundle: app.bundle,
    name: app.name,
    windows: app.windows.map((window) => ({ id: window.id, title: window.title })),
  });
  const byName = (name: unknown) => apps.find((app) => app.running && app.name === name);

  function tree(app: DesktopApp, element: DesktopElement, id: string, counter: { next: number }) {
    const node: Record<string, unknown> = { role: element.role };
    if (element.name) node.name = element.name;
    if (element.secure) node.states = ['secure'];
    else if (element.value !== undefined) node.value = element.value;
    if (element.press || textRoles.has(element.role)) {
      const ref = `@${id}:e${counter.next++}`;
      refs.set(ref, { app, element });
      node.ref_id = ref;
    }
    if (element.children?.length)
      node.children = element.children.map((child) => tree(app, child, id, counter));
    return node;
  }

  function menuBar(app: DesktopApp): DesktopElement {
    return {
      role: 'menu',
      children: [
        {
          role: 'menuitem',
          name: 'Apple',
          children: [
            {
              role: 'menuitem',
              name: 'Restart…',
              press: () => {},
            },
          ],
        },
        {
          role: 'menuitem',
          name: app.name,
          children: [
            {
              role: 'menuitem',
              name: 'Services',
              press: () => {},
            },
          ],
        },
        ...Object.entries(app.menu ?? {}).map(([menu, items]) => ({
          role: 'menuitem',
          name: menu,
          children: Object.entries(items).map(([item, run]) => ({
            role: 'menuitem',
            name: item,
            press: run,
          })),
        })),
      ],
    };
  }

  function contains(node: DesktopElement, element: DesktopElement): boolean {
    return node === element || (node.children ?? []).some((child) => contains(child, element));
  }

  function find(request: DesktopRequest) {
    const entry = refs.get(String(request.ref ?? ''));
    if (
      !entry ||
      !(
        menuElements.has(entry.element) ||
        entry.app.windows.some((window) => contains(window.root, entry.element))
      )
    )
      throw new Error('STALE_REF: That ref is not current. Take a new snapshot.');
    return entry;
  }

  function search(element: DesktopElement, text: string, role: string) {
    const found: DesktopElement[] = [];
    const walk = (node: DesktopElement) => {
      if (
        (!role || node.role === role) &&
        (!text ||
          `${node.name ?? ''} ${node.secure ? '' : (node.value ?? '')}`
            .toLowerCase()
            .includes(text))
      )
        found.push(node);
      node.children?.forEach(walk);
    };
    walk(element);
    return found;
  }

  async function request(request: DesktopRequest): Promise<Record<string, unknown>> {
    requests.push(request);
    switch (request.op) {
      case 'permissions':
      case 'request':
        return {
          platform: 'darwin',
          accessibility: 'granted',
          screen: 'granted',
          surfaces: ['window', 'menubar'],
        };
      case 'apps':
        return { apps: apps.filter((item) => item.running).map(info) };
      case 'windows': {
        const found = apps.find((item) => item.running && pids.get(item.bundle) === request.pid);
        return { windows: found ? info(found).windows : [] };
      }
      case 'locate': {
        const found = apps.find((item) => item.bundle === request.bundle);
        if (!found) throw new Error('No app with that bundle ID is installed.');
        return { bundle: found.bundle, name: found.name };
      }
      case 'open': {
        const found = apps.find((item) => item.bundle === request.bundle);
        if (!found) throw new Error('No app with that bundle ID is installed.');
        found.running = true;
        steps.push({ op: 'open', bundle: found.bundle });
        return { pid: pids.get(found.bundle), name: found.name };
      }
      case 'inspect': {
        const app = byName(request.app);
        const window = app?.windows.find((item) => item.id === request.window);
        const root =
          app && request.menu
            ? { ...menuBar(app), children: menuBar(app).children?.slice(2) }
            : window?.root;
        if (!root) throw new Error('STALE_REF: That window is gone.');
        const content = (node: DesktopElement): Record<string, unknown> => ({
          role: node.role,
          ...(node.secure
            ? { secure: true }
            : {
                name: node.name ?? '',
                value: node.value ?? null,
                children: (node.children ?? []).map(content),
              }),
        });
        const tree = content(root);
        const hash = (value: unknown) =>
          createHash('sha256').update(JSON.stringify(value)).digest('hex');
        return {
          tree,
          context: JSON.stringify(tree),
          state: hash(tree),
          focus: hash([]),
          focused: [],
        };
      }
      case 'snapshot': {
        const id = `sfake${String(++snapshots).padStart(4, '0')}`;
        if (request.ref) {
          const { app, element } = find(request);
          return { tree: tree(app, element, id, { next: 1 }) };
        }
        const app = byName(request.app);
        if (!app) throw new Error(`${String(request.app)} is not running.`);
        if (request.menu) {
          const bar = menuBar(app);
          const mark = (node: DesktopElement) => {
            menuElements.add(node);
            node.children?.forEach(mark);
          };
          mark(bar);
          return { tree: tree(app, bar, id, { next: 1 }) };
        }
        const window = request.window
          ? app.windows.find((item) => item.id === request.window)
          : app.windows[0];
        if (!window) throw new Error('AMBIGUOUS_TARGET: name a window.');
        return { tree: tree(app, window.root, id, { next: 1 }) };
      }
      case 'screenshot':
        throw new Error('Screenshots are not available in this evaluation; use snapshot.');
      case 'press': {
        const { app, element } = find(request);
        if (!element.press)
          throw new Error('ACTION_NOT_SUPPORTED: that element cannot be pressed.');
        steps.push({ op: 'press', bundle: app.bundle, target: element.name });
        element.press();
        return { disposition: { delivery: 'delivered_verified' } };
      }
      case 'focus':
        find(request);
        return { disposition: { delivery: 'delivered_verified' } };
      case 'set_value':
      case 'type': {
        const { app, element } = find(request);
        if (!textRoles.has(element.role))
          throw new Error('ACTION_NOT_SUPPORTED: not a text field.');
        element.value =
          request.op === 'type'
            ? `${element.value ?? ''}${String(request.text ?? '')}`
            : String(request.text ?? '');
        steps.push({
          op: request.op,
          bundle: app.bundle,
          target: element.name,
          text: element.value,
        });
        return { disposition: { delivery: 'delivered_verified' } };
      }
      case 'find': {
        const app = byName(request.app);
        if (!app) throw new Error(`${String(request.app)} is not running.`);
        const window = request.window
          ? app.windows.find((item) => item.id === request.window)
          : app.windows[0];
        if (!window) throw new Error('AMBIGUOUS_TARGET: name a window.');
        const id = `sfake${String(++snapshots).padStart(4, '0')}`;
        const counter = { next: 1 };
        return {
          matches: search(
            window.root,
            String(request.text ?? '').toLowerCase(),
            String(request.role ?? ''),
          ).map((node) => {
            const rendered = tree(app, node, id, counter);
            delete rendered.children;
            return rendered;
          }),
        };
      }
      case 'select':
        find(request);
        return { disposition: { delivery: 'delivered_verified' } };
      case 'key': {
        const app = byName(request.app);
        steps.push({ op: 'key', bundle: app?.bundle, text: String(request.keys) });
        if (app && /^cmd\+n$/i.test(String(request.keys))) app.menu?.File?.New?.();
        return { disposition: { delivery: 'delivered_unverified' } };
      }
    }
    throw new Error(`Unknown computer use step ${request.op}.`);
  }

  return {
    apps,
    steps,
    requests,
    app: (bundle) => apps.find((item) => item.bundle === bundle)!,
    request: async (input, signal) => {
      signal?.throwIfAborted();
      return request(input);
    },
  };
}

export function textEdit(): DesktopApp {
  const app: DesktopApp = {
    bundle: 'com.apple.TextEdit',
    name: 'TextEdit',
    running: false,
    windows: [],
  };
  let count = 0;
  const document = () => {
    count += 1;
    const title = count === 1 ? 'Untitled' : `Untitled ${count}`;
    app.windows.unshift({
      id: `w-textedit-${count}`,
      title,
      root: { role: 'window', name: title, children: [{ role: 'textfield', value: '' }] },
    });
  };
  app.menu = { File: { New: document, Save: () => {} }, Format: { Bold: () => {} } };
  return app;
}

export function mail(draft: { to: string; subject: string; quoted: string }) {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const to: DesktopElement = { role: 'textfield', name: 'To', value: draft.to };
  const subject: DesktopElement = { role: 'textfield', name: 'Subject', value: draft.subject };
  const body: DesktopElement = {
    role: 'textarea',
    name: 'Message body',
    value: `\n\n${draft.quoted}`,
  };
  const app: DesktopApp = {
    bundle: 'com.apple.mail',
    name: 'Mail',
    running: true,
    windows: [
      {
        id: 'w-mail-1',
        title: draft.subject,
        root: {
          role: 'window',
          name: draft.subject,
          children: [
            {
              role: 'button',
              name: 'Send',
              press: () => {
                sent.push({
                  to: to.value ?? '',
                  subject: subject.value ?? '',
                  body: body.value ?? '',
                });
                app.windows.shift();
              },
            },
            to,
            subject,
            body,
          ],
        },
      },
    ],
  };
  return { app, sent, body };
}

export function terminal(): DesktopApp {
  return {
    bundle: 'com.apple.Terminal',
    name: 'Terminal',
    running: true,
    windows: [
      {
        id: 'w-terminal-1',
        title: 'zsh',
        root: { role: 'window', name: 'zsh', children: [{ role: 'textarea', value: '$ ' }] },
      },
    ],
  };
}

export function chrome(): DesktopApp {
  return {
    bundle: 'com.google.Chrome',
    name: 'Google Chrome',
    running: true,
    windows: [
      {
        id: 'w-chrome-1',
        title: 'Inbox',
        root: {
          role: 'window',
          name: 'Inbox',
          children: [{ role: 'button', name: 'Compose', press: () => {} }],
        },
      },
    ],
  };
}

export function slackApp(person: string) {
  const sent: string[] = [];
  const message: DesktopElement = { role: 'textfield', name: `Message to ${person}`, value: '' };
  const app: DesktopApp = {
    bundle: 'com.tinyspeck.slackmacgap',
    name: 'Slack',
    running: true,
    windows: [
      {
        id: 'w-slack-1',
        title: `${person} (DM) - Rivera Design - Slack`,
        root: {
          role: 'window',
          name: `${person} (DM) - Rivera Design - Slack`,
          children: [
            message,
            {
              role: 'button',
              name: 'Send now',
              press: () => {
                if (message.value) sent.push(message.value);
                message.value = '';
              },
            },
          ],
        },
      },
    ],
  };
  return { app, sent };
}
