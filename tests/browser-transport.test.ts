import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import {
  browserSessionId,
  createAgentBrowserComputer,
} from '../src/providers/agent-browser/index.ts';
import { existingDaemonCommand } from '../src/providers/agent-browser/screens.ts';
import { BrowserActionError } from '../src/ports/computer.ts';
import { stagedLoginBrowser } from './login-fixture.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type BrowserTab = { tabId: string; active: boolean; url: string };

async function fixture(respectTimeouts = false) {
  const directory = await mkdtemp('/tmp/sk-transport-');
  const pages = stagedLoginBrowser();
  const actions: string[] = [];
  const launches: string[] = [];
  const sockets = new Set<Socket>();
  let before = async (_action: string, _command: Record<string, unknown>) => {};
  let failedAction: string | undefined;
  let failedMessage = 'Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE PRIVATE-UPSTREAM';
  const switches: string[] = [];
  const timeouts: { action: unknown; timeoutMs: number | undefined }[] = [];
  let tabs = (url: string): BrowserTab[] => [{ tabId: 't1', active: true, url }];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', async (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const command = JSON.parse(input);
      input = '';
      actions.push(command.action);
      await before(command.action, command);
      if (command.action === failedAction) {
        socket.end(
          JSON.stringify({
            success: false,
            error: failedMessage,
          }) + '\n',
        );
        return;
      }
      const page = pages.pages.get('fixture')!;
      let data: Record<string, unknown> = {};
      if (command.action === 'url') data = { url: page.location.href };
      if (command.action === 'tab_list') data = { tabs: tabs(page.location.href) };
      if (command.action === 'tab_switch') switches.push(command.tabId);
      if (command.action === 'evaluate') data = { result: await page.evaluate(command.script) };
      if (command.action === 'snapshot') data = { snapshot: page.text() };
      if (command.action === 'navigate') page.location.href = command.url;
      if (command.action === 'screenshot') await writeFile(command.path, page.screen());
      if (!socket.destroyed) socket.end(JSON.stringify({ success: true, data }) + '\n');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, `${browserSessionId('fixture')}.sock`), resolve),
  );
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    daemonCommand: (path, command, signal, timeoutMs) => {
      timeouts.push({ action: command.action, timeoutMs });
      return existingDaemonCommand(path, command, signal, respectTimeouts ? timeoutMs : 250);
    },
    run: async (executable, args, options) => {
      if (args.includes('info')) {
        launches.push('info');
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              active: true,
              namespace: args[args.indexOf('--namespace') + 1],
              session: args[args.indexOf('--session') + 1],
              socketDir: directory,
            },
          }),
        };
      }
      const action = args[args.indexOf('--idle-timeout') + 2];
      launches.push(action);
      assert.equal(action, 'open', 'Warm actions must not invoke the retrying CLI');
      return pages.run(executable, args, options);
    },
  });
  return {
    computer,
    actions,
    launches,
    page: () => pages.pages.get('fixture')!,
    switches,
    timeouts,
    tabs(value: typeof tabs) {
      tabs = value;
    },
    fail(action?: string, message?: string) {
      failedAction = action;
      if (message !== undefined) failedMessage = message;
    },
    before(value: typeof before) {
      before = value;
    },
    async cleanup() {
      before = async () => {};
      await computer.dispose().catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('warm browser commands use one private socket request and reuse the launched profile', async () => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/other' });
    await f.computer.screenshot('fixture');
    assert.deepEqual(f.launches, ['open', 'info']);
    assert.equal(f.actions.filter((action) => action === 'navigate').length, 1);
    assert.equal(f.actions.filter((action) => action === 'screenshot').length, 1);
  } finally {
    await f.cleanup();
  }
});

const interceptedMessage = (target: string, blocker = 'div#private-fixture-secret') =>
  `Element '${target}' is covered by <${blocker}> at its click point, so the input would land on that element instead. Dismiss or interact with the covering element first (it is often a dialog, banner, or sticky header).`;

test('only exact matching native click interception is classified as a safe refusal', async () => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    for (const blocker of [
      'div',
      'div#private-fixture-secret',
      'div inside div#private-fixture-secret',
    ]) {
      f.fail('click', interceptedMessage('@e1', blocker));
      await assert.rejects(
        f.computer.act('fixture', { action: 'click', selector: '@e1' }),
        (error: unknown) => {
          assert.ok(error instanceof BrowserActionError);
          assert.equal(error.code, 'browser_click_intercepted');
          assert.doesNotMatch(error.message, /private-fixture-secret|@e1/);
          return true;
        },
      );
    }
    for (const message of [
      interceptedMessage('@other'),
      `Prefix ${interceptedMessage('@e1')}`,
      `${interceptedMessage('@e1')} suffix`,
      "Element '@e1' is covered by <div>",
      'Private failure after mouse dispatch',
    ]) {
      f.fail('click', message);
      await assert.rejects(
        f.computer.act('fixture', { action: 'click', selector: '@e1' }),
        (error: unknown) => error instanceof Error && !(error instanceof BrowserActionError),
      );
    }
    f.fail('evaluate', interceptedMessage('@e1'));
    await assert.rejects(
      f.computer.act('fixture', { action: 'snapshot' }),
      (error: unknown) => error instanceof Error && !(error instanceof BrowserActionError),
    );
    await assert.rejects(
      f.computer.act('fixture', { action: 'click', selector: '@e1' }),
      (error: unknown) => error instanceof Error && !(error instanceof BrowserActionError),
    );
    f.fail();
    assert.match((await f.computer.act('fixture', { action: 'snapshot' })).text, /Sign in/);
    assert.equal(f.actions.filter((action) => action === 'click').length, 9);
    assert.equal(f.actions.includes('close'), false);
    assert.deepEqual(f.launches, ['open', 'info']);
  } finally {
    await f.cleanup();
  }
});

test('a blank page after a click is reported without failing the action', async () => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    f.before(async (action) => {
      if (action === 'click') f.page().location.href = 'about:blank';
    });
    const opened = await f.computer.act('fixture', { action: 'click', selector: '@e1' });
    assert.equal(opened.url, 'about:blank');
    f.page().location.href = 'https://1.1.1.1/login';
    assert.equal(
      (await f.computer.act('fixture', { action: 'snapshot' })).url,
      'https://1.1.1.1/login',
    );
    f.page().location.href = 'chrome-error://chromewebdata/';
    await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /HTTP or HTTPS/);
    assert.equal(f.actions.filter((action) => action === 'click').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('a new tab that closes before it loads leaves the opener active', async () => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    let lists = 0;
    f.tabs((url) =>
      ++lists === 1
        ? [{ tabId: 't1', active: true, url }]
        : lists === 2
          ? [
              { tabId: 't1', active: false, url },
              { tabId: 't2', active: true, url: '' },
            ]
          : [{ tabId: 't1', active: false, url }],
    );
    const observed = await f.computer.act('fixture', { action: 'click', selector: '@e1' });
    assert.equal(observed.url, 'https://1.1.1.1/login');
    assert.deepEqual(f.switches, ['t1']);
    assert.equal(lists, 3);
  } finally {
    await f.cleanup();
  }
});

test('a new tab is followed only after its address is stable', async () => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    let lists = 0;
    f.tabs((url) =>
      ++lists === 1
        ? [{ tabId: 't1', active: true, url }]
        : [
            { tabId: 't1', active: true, url: 'https://1.1.1.1/login' },
            {
              tabId: 't2',
              active: false,
              url:
                lists === 2
                  ? ''
                  : lists === 3
                    ? 'https://1.1.1.1/redirect'
                    : 'https://1.1.1.1/other',
            },
          ],
    );
    f.before(async (action, command) => {
      if (action === 'tab_switch' && command.tabId === 't2')
        f.page().location.href = 'https://1.1.1.1/other';
    });
    const observed = await f.computer.act('fixture', { action: 'click', selector: '@e1' });
    assert.equal(observed.url, 'https://1.1.1.1/other');
    assert.deepEqual(f.switches, ['t2']);
    assert.equal(lists, 5);
  } finally {
    await f.cleanup();
  }
});

test('a new tab that closes during the switch returns to the opener', async () => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    let lists = 0;
    let closed = false;
    f.tabs((url) =>
      ++lists === 1 || closed
        ? [{ tabId: 't1', active: !closed, url }]
        : [
            { tabId: 't1', active: true, url },
            { tabId: 't2', active: false, url: 'https://1.1.1.1/other' },
          ],
    );
    f.before(async (action, command) => {
      if (action === 'tab_switch' && command.tabId === 't2') {
        closed = true;
        f.fail('tab_switch', 'Tab closed');
      } else if (action === 'tab_switch') f.fail();
    });
    const observed = await f.computer.act('fixture', { action: 'click', selector: '@e1' });
    assert.equal(observed.url, 'https://1.1.1.1/login');
    assert.deepEqual(f.switches, ['t1']);
  } finally {
    await f.cleanup();
  }
});

test('a new tab that stays blank is ignored after the bounded wait', async (t) => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    let lists = 0;
    f.tabs((url) => {
      if (++lists === 1) return [{ tabId: 't1', active: true, url }];
      t.mock.timers.tick(2000);
      return [
        { tabId: 't1', active: false, url },
        { tabId: 't2', active: true, url: 'about:blank' },
      ];
    });
    const observed = await f.computer.act('fixture', { action: 'press', key: 'Enter' });
    assert.equal(observed.url, 'https://1.1.1.1/login');
    assert.deepEqual(f.switches, ['t1']);
    assert.equal(lists, 4);
  } finally {
    await f.cleanup();
  }
});

test('a new tab whose address keeps changing is ignored after the bounded wait', async (t) => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    let lists = 0;
    f.tabs((url) => {
      if (++lists === 1) return [{ tabId: 't1', active: true, url }];
      t.mock.timers.tick(2000);
      return [
        { tabId: 't1', active: false, url },
        { tabId: 't2', active: true, url: `https://1.1.1.1/redirect/${lists}` },
      ];
    });
    const observed = await f.computer.act('fixture', { action: 'click', selector: '@e1' });
    assert.equal(observed.url, 'https://1.1.1.1/login');
    assert.deepEqual(f.switches, ['t1']);
    assert.equal(lists, 4);
  } finally {
    await f.cleanup();
  }
});

test('a timed out snapshot is not resent and its queue remains fenced until close is acknowledged', async () => {
  const f = await fixture();
  const closeStarted = deferred();
  const releaseClose = deferred();
  const releaseSnapshot = deferred();
  let finished = false;
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const before = f.actions.length;
    f.before(async (action) => {
      if (action === 'snapshot') await releaseSnapshot.promise;
      if (action === 'close') {
        closeStarted.resolve();
        await releaseClose.promise;
      }
    });
    const failed = assert
      .rejects(f.computer.act('fixture', { action: 'snapshot' }), /unavailable/)
      .finally(() => {
        finished = true;
      });
    await closeStarted.promise;
    assert.equal(finished, false);
    const queued = assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /expired/);
    releaseSnapshot.resolve();
    releaseClose.resolve();
    await Promise.all([failed, queued]);
    assert.equal(f.actions.slice(before).filter((action) => action === 'snapshot').length, 1);
    assert.equal(f.actions.slice(before).filter((action) => action === 'close').length, 1);
    assert.deepEqual(f.launches, ['open', 'info']);
  } finally {
    releaseSnapshot.resolve();
    releaseClose.resolve();
    await f.cleanup();
  }
});

test('a completed daemon error keeps the session available and navigation failures retain their typed boundary', async () => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    f.fail('snapshot');
    await assert.rejects(
      f.computer.act('fixture', { action: 'snapshot' }),
      /Browser action could not complete/,
    );
    assert.equal(f.actions.includes('close'), false);
    f.fail();
    assert.match((await f.computer.act('fixture', { action: 'snapshot' })).text, /Sign in/);
    f.fail('navigate');
    await assert.rejects(
      f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/denied' }),
      (error: unknown) => {
        assert.ok(error instanceof BrowserActionError);
        assert.equal(error.code, 'browser_navigation_failed');
        assert.doesNotMatch(error.message, /PRIVATE|HTTP_RESPONSE/);
        return true;
      },
    );
    assert.equal(f.actions.includes('close'), false);
  } finally {
    await f.cleanup();
  }
});

for (const failedClose of [false, true]) {
  test(`interrupted credential feedback preserves the ${failedClose ? 'unconfirmed' : 'confirmed'} close fence without replay or cleanup commands`, async () => {
    const f = await fixture();
    const releaseFeedback = deferred();
    try {
      await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      const login = await f.computer.inspectLogin('fixture');
      let feedbackCalls = 0;
      f.before(async (action, command) => {
        if (
          action === 'evaluate' &&
          typeof command.script === 'string' &&
          command.script.includes('mark=false;')
        ) {
          feedbackCalls++;
          await releaseFeedback.promise;
        }
        if (action === 'close') {
          releaseFeedback.resolve();
          if (failedClose) f.fail('close');
        }
      });
      await assert.rejects(
        f.computer.injectCredentials({
          taskId: 'fixture',
          origin: login.origin,
          kind: 'identifier',
          username: 'private-credential-fixture@example.test',
          usernameSelector: login.fields[0].selector,
          submitSelector: login.submitSelector,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            'Secure entry could not be confirmed. Check the login page before continuing.',
          );
          return true;
        },
      );
      assert.equal(feedbackCalls, 1);
      const closed = f.actions.indexOf('close');
      assert.notEqual(closed, -1);
      assert.deepEqual(f.actions.slice(closed), ['close']);
      await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /expired/);
      assert.deepEqual(f.actions.slice(closed), ['close']);
      assert.deepEqual(f.launches, ['open', 'info']);
    } finally {
      releaseFeedback.resolve();
      f.fail();
      await f.cleanup();
    }
  });
}

test('completed credential feedback errors remain optional while the browser is healthy', async () => {
  const f = await fixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const login = await f.computer.inspectLogin('fixture');
    let feedbackCalls = 0;
    f.before(async (action, command) => {
      if (
        action === 'evaluate' &&
        typeof command.script === 'string' &&
        command.script.includes('mark=false;')
      ) {
        feedbackCalls++;
        f.fail('evaluate');
      } else f.fail();
    });
    assert.deepEqual(
      await f.computer.injectCredentials({
        taskId: 'fixture',
        origin: login.origin,
        kind: 'identifier',
        username: 'private-credential-fixture@example.test',
        usernameSelector: login.fields[0].selector,
        submitSelector: login.submitSelector,
      }),
      { status: 'submitted' },
    );
    assert.ok(feedbackCalls > 1);
    assert.equal(f.actions.includes('close'), false);
    const observation = await f.computer.act('fixture', { action: 'snapshot' });
    assert.match(observation.text, /Sign in password/);
    assert.equal(observation.text.includes('private-credential-fixture@example.test'), false);
    assert.deepEqual(f.launches, ['open', 'info']);
  } finally {
    f.fail();
    await f.cleanup();
  }
});

test('closing during successful credential feedback cannot report submission or clear credentials', async () => {
  const f = await fixture();
  const feedbackStarted = deferred();
  const releaseFeedback = deferred();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const login = await f.computer.inspectLogin('fixture');
    let feedbackIndex = -1;
    let clearingCommands = 0;
    f.before(async (action, command) => {
      if (
        action === 'evaluate' &&
        typeof command.script === 'string' &&
        command.script.includes("e.value=''")
      )
        clearingCommands++;
      if (
        action === 'evaluate' &&
        typeof command.script === 'string' &&
        command.script.includes('mark=false;')
      ) {
        feedbackIndex = f.actions.length - 1;
        feedbackStarted.resolve();
        await releaseFeedback.promise;
      }
    });
    const rejected = assert.rejects(
      f.computer.injectCredentials({
        taskId: 'fixture',
        origin: login.origin,
        kind: 'identifier',
        username: 'private-credential-fixture@example.test',
        usernameSelector: login.fields[0].selector,
        submitSelector: login.submitSelector,
      }),
      /Secure entry could not be confirmed/,
    );
    await feedbackStarted.promise;
    const closed = f.computer.close('fixture');
    releaseFeedback.resolve();
    await Promise.all([rejected, closed]);
    assert.notEqual(feedbackIndex, -1);
    assert.equal(clearingCommands, 0);
    assert.equal(f.actions.filter((action) => action === 'close').length, 1);
    assert.equal(f.actions.at(-1), 'close');
    const completedActions = f.actions.length;
    await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /Open a website first/);
    assert.equal(f.actions.length, completedActions);
  } finally {
    releaseFeedback.resolve();
    await f.cleanup();
  }
});

test('daemon command deadline stays absolute when a peer drips an unfinished response', async () => {
  const directory = await mkdtemp('/tmp/sk-deadline-');
  const path = join(directory, 'daemon.sock');
  let received = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      received++;
      timer = setInterval(() => socket.write(' '), 5);
    });
    socket.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    await assert.rejects(
      existingDaemonCommand(path, { action: 'snapshot' }, undefined, 30),
      /unavailable/,
    );
    assert.equal(received, 1);
  } finally {
    clearInterval(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a stalled tab poll uses only the remaining settle budget and honors caller cancellation', async (t) => {
  for (const cancelled of [false, true]) {
    const f = await fixture(true);
    const held = deferred();
    const controller = new AbortController();
    try {
      await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      let lists = 0;
      f.tabs((url) => {
        if (++lists === 1) return [{ tabId: 't1', active: true, url }];
        t.mock.timers.tick(4800);
        return [
          { tabId: 't1', active: true, url },
          { tabId: 't2', active: false, url: '' },
        ];
      });
      f.before(async (action) => {
        if (action === 'tab_list' && lists === 2) {
          if (cancelled) controller.abort();
          await held.promise;
        }
      });
      await assert.rejects(
        f.computer.act('fixture', { action: 'click', selector: '@e1' }, controller.signal),
        cancelled ? /Browser observation cancelled/ : /previous browser is unavailable/,
      );
      const poll = f.timeouts.filter((entry) => entry.action === 'tab_list').at(-1)!;
      assert.ok(poll.timeoutMs! > 0 && poll.timeoutMs! <= 200);
      assert.ok(f.actions.includes('close'));
    } finally {
      f.tabs((url) => [{ tabId: 't1', active: true, url }]);
      held.resolve();
      await f.cleanup();
      t.mock.timers.reset();
    }
  }
});
