import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BrowserActionError } from '../src/ports/computer.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import {
  DaemonCommandError,
  existingDaemonCommand,
} from '../src/providers/agent-browser/screens.ts';
import type { ProcessOptions } from '../src/providers/process.ts';

type Options = Parameters<typeof createAgentBrowserComputer>[0] & {
  onDaemonCommand?(command: Record<string, unknown>): unknown;
};

export function createBrowserFixture(options: Options, preferRealSocket = false) {
  const { onDaemonCommand, ...computerOptions } = options;
  const run = options.run;
  if (!run) throw new Error('A synthetic browser process is required.');
  const sessions = new Map<
    string,
    { executable: string; args: string[]; options?: ProcessOptions }
  >();
  const socketDir = resolve(options.dataRoot, 'fixture-sockets');
  return createAgentBrowserComputer({
    ...computerOptions,
    headless: true,
    run: async (executable, args, input) => {
      const session = args[args.indexOf('--session') + 1];
      if (args.includes('info')) {
        if (preferRealSocket || !sessions.has(session)) {
          const result = await run(executable, args, input);
          if (!sessions.has(session)) return result;
          let response;
          try {
            response = JSON.parse(result.stdout);
          } catch {
            throw new DaemonCommandError();
          }
          if (!response || typeof response !== 'object' || Array.isArray(response))
            throw new DaemonCommandError();
          const info = response.data;
          if (
            info?.active &&
            typeof info.socketDir === 'string' &&
            (await stat(resolve(info.socketDir, `${session}.sock`)).catch(() => null))?.isSocket()
          )
            return result;
        }
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              active: true,
              namespace: args[args.indexOf('--namespace') + 1],
              session,
              socketDir,
            },
          }),
        };
      }
      const offset = args.indexOf('--idle-timeout') + 2;
      if (offset > 1)
        sessions.set(session, { executable, args: args.slice(0, offset), options: input });
      return run(executable, args, input);
    },
    daemonCommand: async (path, command, signal, timeoutMs) => {
      await onDaemonCommand?.(structuredClone(command));
      const session = [...sessions].find(([id]) => path === resolve(socketDir, `${id}.sock`))?.[1];
      if (!session) return existingDaemonCommand(path, command, signal, timeoutMs);
      if (command.action === 'tab_list') {
        const result = await run(session.executable, [...session.args, 'get', 'url'], {
          ...session.options,
          signal,
        });
        let response;
        try {
          response = JSON.parse(result.stdout);
        } catch {
          throw new DaemonCommandError();
        }
        if (
          !response ||
          typeof response !== 'object' ||
          result.exitCode ||
          response.success === false
        )
          throw new DaemonCommandError();
        return {
          tabs: [
            {
              tabId: 't1',
              targetId: 'fixture-target',
              active: true,
              url: String(response.data?.url ?? ''),
            },
          ],
        };
      }
      const args =
        command.action === 'navigate'
          ? ['open', String(command.url)]
          : command.action === 'url'
            ? ['get', 'url']
            : command.action === 'cdp_url'
              ? ['get', 'cdp-url']
              : command.action === 'focus'
                ? ['focus', String(command.selector)]
                : command.action === 'getattribute'
                  ? ['get', 'attr', String(command.selector), String(command.attribute)]
                  : command.action === 'evaluate'
                    ? ['eval', '--stdin']
                    : command.action === 'snapshot'
                      ? [
                          'snapshot',
                          ...(command.compact === true ? ['-c'] : []),
                          ...(command.interactive === true ? ['-i'] : []),
                          ...(typeof command.selector === 'string' ? ['-s', command.selector] : []),
                        ]
                      : command.action === 'screenshot'
                        ? [
                            'screenshot',
                            String(command.path),
                            ...(command.fullPage === true ? ['--full'] : []),
                            ...(command.format === 'jpeg' ? ['--screenshot-format', 'jpeg'] : []),
                          ]
                        : command.action === 'click'
                          ? ['click', String(command.selector)]
                          : command.action === 'fill'
                            ? ['fill', String(command.selector), String(command.value)]
                            : command.action === 'type'
                              ? ['type', String(command.selector), String(command.text)]
                              : command.action === 'select'
                                ? ['select', String(command.selector), String(command.value)]
                                : ['check', 'uncheck', 'hover'].includes(String(command.action))
                                  ? [String(command.action), String(command.selector)]
                                  : command.action === 'drag'
                                    ? ['drag', String(command.source), String(command.target)]
                                    : command.action === 'upload'
                                      ? ['upload', String(command.selector), String(command.file)]
                                      : command.action === 'press'
                                        ? ['press', String(command.key)]
                                        : command.action === 'scroll'
                                          ? [
                                              'scroll',
                                              String(command.direction),
                                              String(command.amount),
                                              ...(typeof command.selector === 'string'
                                                ? ['-s', command.selector]
                                                : []),
                                            ]
                                          : command.action === 'mousemove'
                                            ? [
                                                'mouse',
                                                'move',
                                                String(command.x),
                                                String(command.y),
                                              ]
                                            : command.action === 'mousedown' ||
                                                command.action === 'mouseup'
                                              ? ['mouse', command.action.slice(5)]
                                              : command.action === 'wheel'
                                                ? ['mouse', 'wheel', String(command.deltaY)]
                                                : command.action === 'keyboard'
                                                  ? ['keyboard', 'type', String(command.text)]
                                                  : command.action === 'dialog'
                                                    ? [
                                                        'dialog',
                                                        String(command.response),
                                                        ...(typeof command.promptText === 'string'
                                                          ? [command.promptText]
                                                          : []),
                                                      ]
                                                    : ['back', 'forward', 'reload'].includes(
                                                          String(command.action),
                                                        )
                                                      ? [String(command.action)]
                                                      : command.action === 'close'
                                                        ? ['close']
                                                        : [
                                                              'scrollintoview',
                                                              'boundingbox',
                                                            ].includes(String(command.action))
                                                          ? [
                                                              String(command.action),
                                                              String(command.selector),
                                                            ]
                                                          : null;
      if (!args) throw new Error('Unsupported synthetic browser action.');
      const result = await run(session.executable, [...session.args, ...args], {
        ...session.options,
        signal,
        ...(command.action === 'evaluate' && { input: String(command.script) }),
      });
      const response = JSON.parse(result.stdout);
      if (result.exitCode || response.success === false) {
        if (
          command.action === 'navigate' &&
          /^Navigation failed: net::ERR_[A-Z_]+/.test(String(response.error))
        )
          throw new BrowserActionError('browser_navigation_failed');
        throw new DaemonCommandError();
      }
      return response.data ?? {};
    },
  });
}

export type DevtoolsFrame = { id: string; session: string; origin: string; parent?: string };
export type DevtoolsModel = {
  frames: DevtoolsFrame[];
  document: string;
  focused?: string;
  field?: string;
  armed?: string;
  frameOf: Record<string, string>;
  values: Map<string, string>;
  evaluate?(expression: string): unknown;
  masked?: boolean;
  failMasks?: boolean;
  steal?: { after: number; field: string };
};

export async function fakeDevtools(model: DevtoolsModel) {
  const server = createServer();
  const sockets = new Set<Socket>();
  const worlds = new Map<string, object>();
  server.on('upgrade', (request, socket: Socket) => {
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const send = (message: unknown) => {
      const data = Buffer.from(JSON.stringify(message));
      const header =
        data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, 0, 0]);
      if (data.length >= 126) header.writeUInt16BE(data.length, 2);
      socket.write(Buffer.concat([header, data]));
    };
    const evaluate = (frame: DevtoolsFrame, expression: string) => {
      if (model.evaluate) return model.evaluate(expression);
      if (expression.includes('globalThis.__nodScripted')) {
        const key = `${model.document}:${frame.id}`;
        let world = worlds.get(key);
        if (!world) worlds.set(key, (world = {}));
        return runInNewContext(expression, world);
      }
      const here = model.focused === frame.id;
      if (expression.includes('globalThis.__nodMaskedStyles')) {
        model.masked = expression.includes("if (!true) return ''");
        return '';
      }
      if (expression.includes('.blur()')) {
        if (here) model.focused = model.field = undefined;
        return '';
      }
      if (expression.includes('__nodField = node')) {
        if (!here) return '';
        model.armed = model.field;
        model.values.set(model.field!, '');
        return 'INPUT';
      }
      if (expression.includes("execCommand('insertText'")) {
        if (!here || model.armed !== model.field) return false;
        const field = model.field!;
        const node = { tagName: 'INPUT', isConnected: true };
        return runInNewContext(expression, {
          __nodField: node,
          document: {
            hasFocus: () => model.focused === frame.id,
            get activeElement() {
              return model.field === field ? node : null;
            },
            execCommand: (_command: string, _showUI: boolean, text: string) => {
              model.values.set(field, `${model.values.get(field) ?? ''}${text}`);
              if (model.steal && !--model.steal.after) {
                model.field = model.steal.field;
                model.focused = model.frameOf[model.steal.field];
              }
              return true;
            },
          },
        });
      }
      return here ? 'INPUT' : '';
    };
    const handle = (message: {
      id: number;
      method: string;
      params: Record<string, unknown>;
      sessionId?: string;
    }) => {
      const session = message.sessionId;
      const frames = model.frames.filter((frame) => frame.session === session);
      const reply = (result: unknown) => send({ id: message.id, result, sessionId: session });
      if (message.method === 'Network.enable') return reply({});
      if (message.method === 'DOM.getDocument') return reply({ root: { backendNodeId: 1 } });
      if (message.method === 'Runtime.releaseObjectGroup') return reply({});
      if (message.method === 'Target.attachToTarget') return reply({ sessionId: 'page' });
      if (message.method === 'Target.getTargets')
        return reply({ targetInfos: [{ targetId: 'fixture-target', type: 'page' }] });
      if (message.method === 'Target.setAutoAttach') {
        for (const child of new Set(
          model.frames
            .filter((frame) => frame.parent === session && frame.session !== session)
            .map((frame) => frame.session),
        ))
          send({
            method: 'Target.attachedToTarget',
            params: { sessionId: child, targetInfo: { type: 'iframe' } },
            sessionId: session,
          });
        return reply({});
      }
      if (message.method === 'Page.getFrameTree')
        return reply({
          frameTree: {
            frame: {
              id: frames[0]!.id,
              securityOrigin: frames[0]!.origin,
              ...(session === 'page' ? { loaderId: model.document } : {}),
            },
            childFrames: frames
              .slice(1)
              .map((frame) => ({ frame: { id: frame.id, securityOrigin: frame.origin } })),
          },
        });
      if (message.method === 'Page.getNavigationHistory')
        return reply({
          currentIndex: 0,
          entries: [{ url: `${frames[0]?.origin}/`, transitionType: 'typed' }],
        });
      if (message.method === 'Page.createIsolatedWorld')
        return reply({
          executionContextId: model.frames.findIndex(
            (frame) => frame.id === message.params.frameId,
          ),
        });
      if (message.method === 'Runtime.evaluate' && message.params.throwOnSideEffect)
        return reply({ exceptionDetails: { text: 'Side-effect checks need a real browser.' } });
      if (
        message.method === 'Runtime.evaluate' &&
        model.failMasks &&
        String(message.params.expression).includes('globalThis.__nodMaskedStyles') &&
        String(message.params.expression).includes("if (!true) return ''")
      )
        return reply({ exceptionDetails: { text: 'Synthetic mask failure.' } });
      if (message.method === 'Runtime.evaluate')
        return reply({
          result: {
            value:
              message.params.expression === 'globalThis.__nodRoots = [];'
                ? ''
                : evaluate(
                    model.frames[Number(message.params.contextId)]!,
                    String(message.params.expression),
                  ),
          },
        });
      send({ id: message.id, error: { message: 'Unsupported' }, sessionId: session });
    };
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!;
        const opcode = buffer[0]! & 0x0f;
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) return void socket.end();
        if (opcode === 1) handle(JSON.parse(payload.toString()));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/fixture`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
