import { createBrowserWorkerFixture as harness } from './browser-fixture.ts';
import { existingDaemonCommand } from '../src/providers/agent-browser/screens.ts';
import { openDevtools } from '../src/providers/agent-browser/devtools.ts';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserActionError, type BrowserAction } from '../src/ports/computer.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Computer } from '../src/ports/computer.ts';
import { withFailureLog } from '../src/ports/failure-log.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  'reloading a page reached by a form POST does not resubmit it',
  { timeout: 60_000 },
  async () => {
    let posts = 0;
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.method === 'POST') {
        posts += 1;
        response.end(`<title>Done</title><p>count ${posts}</p>`);
        return;
      }
      response.end('<form method="post" action="/submit"><button id="go">Go</button></form>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-reload-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    try {
      await computer.act('post', { action: 'open', url: origin });
      await computer.act('post', { action: 'click', selector: '#go' });
      await computer.act('post', { action: 'wait', text: 'count 1' });
      assert.equal(posts, 1);
      await computer.act('post', { action: 'reload' });
      await computer.act('post', { action: 'wait', load: 'load' });
      assert.equal(posts, 1);
      await computer.act('post', { action: 'open', url: origin });
      await computer.act('post', { action: 'reload' });
      assert.equal(posts, 1);
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'private sign-in submits with a button that cannot take focus',
  { timeout: 60_000 },
  async () => {
    let username = '';
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.method !== 'POST') {
        response.end(
          '<form method="post" action="/session"><input id="account" name="account"><input id="secret" name="secret" type="password"><div id="go" role="button" onclick="this.parentElement.submit()">Sign in</div></form>',
        );
        return;
      }
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        username = new URLSearchParams(body).get('account') ?? '';
        response.end('<title>Done</title><p>Signed in</p>');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-sign-in-button-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    try {
      await computer.act('login', { action: 'open', url: origin });
      await computer.injectCredentials({
        threadId: 'login',
        origin,
        kind: 'password',
        username: 'synthetic@example.com',
        password: 'fixture-secret',
        usernameSelector: '#account',
        passwordSelector: '#secret',
        submitSelector: '#go',
      });
      await computer.act('login', { action: 'wait', text: 'Signed in' });
      assert.equal(username, 'synthetic@example.com');
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'private frame input refuses a control center outside the root viewport before dispatch',
  { skip: process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true', timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'nod-method-viewport-'));
    let submitted = 0;
    const server = createHttpServer((request, response) => {
      if (request.method === 'POST') {
        submitted++;
        response.end('Selected');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        request.url === '/inner'
          ? '<form action="/selected" method="post"><button id="primary" style="width:300px;height:40px">Continue</button></form>'
          : `<iframe style="position:fixed;left:120px;top:50px;width:500px;height:300px;border:0" src="http://localhost:${(server.address() as { port: number }).port}/inner" onload="document.getElementById('ready').textContent='Frame ready'"></iframe><p id="ready"></p>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    let socketPath = '';
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
      viewport: { width: 180, height: 600 },
      daemonCommand: async (path, command, signal, timeoutMs) => {
        socketPath = path;
        return existingDaemonCommand(path, command, signal, timeoutMs);
      },
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await computer.act('fixture', { action: 'open', url: `http://127.0.0.1:${address.port}` });
      await computer.act('fixture', { action: 'wait', text: 'Frame ready' });
      const connection = await existingDaemonCommand(socketPath, { action: 'cdp_url' });
      const tabs = await existingDaemonCommand(socketPath, { action: 'tab_list' });
      const tab = (tabs.tabs as { active: boolean; targetId: string }[]).find(
        (value) => value.active,
      )!;
      const inspector = await openDevtools(String(connection.cdpUrl), tab.targetId);
      const inputs: string[] = [];
      try {
        const bound = await inspector.signInControl({ selector: '#primary' });
        const original = WebSocket.prototype.send;
        const sending = t.mock.method(
          WebSocket.prototype,
          'send',
          function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
            const message = typeof data === 'string' ? JSON.parse(data) : undefined;
            if (message?.method === 'Input.dispatchMouseEvent') inputs.push(message.params.type);
            original.call(this, data);
          },
        );
        try {
          await assert.rejects(inspector.selectSignInControl(bound), (error: unknown) => {
            assert.equal(Object(error).signInGuard, 'control_hidden');
            return true;
          });
        } finally {
          sending.mock.restore();
        }
        assert.deepEqual(inputs, []);
        assert.equal(submitted, 0);
      } finally {
        inspector.close();
      }
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'private submission stops before a click when its browser closes',
  { timeout: 20_000 },
  async () => {
    let submissions = 0;
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/submit') {
        submissions++;
        response.end('<h1>Unexpected submission</h1>');
      } else
        response.end(`<form action="/submit" method="post"><input id="password" type="password"><button id="submit" disabled>Continue</button></form><script>
        document.querySelector('input').oninput=()=>{clearTimeout(window.validation);window.validation=setTimeout(()=>document.querySelector('button').disabled=false,1500)};
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-private-close-'));
    let disabled!: () => void;
    const waiting = new Promise<void>((resolve) => {
      disabled = resolve;
    });
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
      daemonCommand: async (path, command, signal, timeout, maxBytes) => {
        const result = await existingDaemonCommand(path, command, signal, timeout, maxBytes);
        if (command.action === 'isenabled' && result.enabled === false) disabled();
        return result;
      },
    });
    try {
      await computer.act('closing', { action: 'open', url: origin });
      const outcome = computer
        .injectCredentials({
          threadId: 'closing',
          origin,
          kind: 'password',
          password: 'Synthetic close password',
          passwordSelector: '#password',
          submitSelector: '#submit',
        })
        .then(
          () => true,
          () => false,
        );
      await waiting;
      const [submitted] = await Promise.all([outcome, computer.discard('closing')]);
      assert.equal(submitted, false);
      assert.equal(submissions, 0);
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'private submission stops before a click when its operation is cancelled',
  { timeout: 20_000 },
  async () => {
    let submissions = 0;
    const controller = new AbortController();
    const validated = deferred();
    const enabled = deferred();
    const server = createHttpServer(async (request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/submit') {
        submissions++;
        response.end('<h1>Unexpected submission</h1>');
      } else if (request.url === '/validated') {
        await validated.promise;
        response.end();
      } else if (request.url === '/enabled') {
        enabled.resolve();
        response.end();
      } else
        response.end(`<form action="/submit" method="post"><input id="password" type="password"><button id="submit" disabled>Continue</button></form><script>
        document.querySelector('input').oninput=()=>{window.validation??=fetch('/validated').then(()=>{document.querySelector('button').disabled=false;fetch('/enabled')})};
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-private-close-'));
    let disabled!: () => void;
    const waiting = new Promise<void>((resolve) => {
      disabled = resolve;
    });
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
      daemonCommand: async (path, command, signal, timeout, maxBytes) => {
        const result = await existingDaemonCommand(path, command, signal, timeout, maxBytes);
        if (command.action === 'isenabled' && result.enabled === false) disabled();
        return result;
      },
    });
    try {
      await computer.act('closing', { action: 'open', url: origin });
      const outcome = computer
        .injectCredentials(
          {
            threadId: 'closing',
            origin,
            kind: 'password',
            password: 'Synthetic close password',
            passwordSelector: '#password',
            submitSelector: '#submit',
          },
          controller.signal,
        )
        .then(
          () => true,
          () => false,
        );
      await waiting;
      controller.abort();
      const submitted = await outcome;
      validated.resolve();
      await enabled.promise;
      await delay(300);
      assert.equal(submitted, false);
      assert.equal(submissions, 0);
      await computer.act('closing', { action: 'reload' });
      assert.equal((await computer.currentPage('closing')).origin, origin);
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'private submission stops before a queued click reaches the browser',
  { timeout: 20_000 },
  async () => {
    let submissions = 0;
    const controller = new AbortController();
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/submit') {
        submissions++;
        response.end('<h1>Unexpected submission</h1>');
      } else
        response.end(`<form action="/submit" method="post"><input id="password" type="password"><button id="submit" disabled>Continue</button></form><script>
        document.querySelector('input').oninput=()=>{clearTimeout(window.validation);window.validation=setTimeout(()=>document.querySelector('button').disabled=false,300)};
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-private-close-'));
    let disabled!: () => void;
    const waiting = new Promise<void>((resolve) => {
      disabled = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
      daemonCommand: async (path, command, signal, timeout, maxBytes) => {
        if (command.action === 'click' && command.selector === '#submit') {
          disabled();
          await gate;
        }
        return existingDaemonCommand(path, command, signal, timeout, maxBytes);
      },
    });
    try {
      await computer.act('closing', { action: 'open', url: origin });
      const outcome = computer
        .injectCredentials(
          {
            threadId: 'closing',
            origin,
            kind: 'password',
            password: 'Synthetic close password',
            passwordSelector: '#password',
            submitSelector: '#submit',
          },
          controller.signal,
        )
        .then(
          () => true,
          () => false,
        );
      await waiting;
      controller.abort();
      release();
      const submitted = await outcome;
      await delay(500);
      assert.equal(submissions, 0);
      assert.equal(submitted, false);
      await computer.act('closing', { action: 'open', url: origin });
      assert.equal((await computer.currentPage('closing')).origin, origin);
    } finally {
      release();
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'private card submission stops before a click when its operation is cancelled',
  { timeout: 20_000 },
  async () => {
    let submissions = 0;
    const controller = new AbortController();
    const validated = deferred();
    const enabled = deferred();
    const server = createHttpServer(async (request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/submit') {
        submissions++;
        response.end('<h1>Unexpected submission</h1>');
      } else if (request.url === '/validated') {
        await validated.promise;
        response.end();
      } else if (request.url === '/enabled') {
        enabled.resolve();
        response.end();
      } else
        response.end(`<form action="/submit" method="post"><input id="password" type="password"><button id="submit" disabled>Continue</button></form><script>
        document.querySelector('input').oninput=()=>{window.validation??=fetch('/validated').then(()=>{document.querySelector('button').disabled=false;fetch('/enabled')})};
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-private-close-'));
    let disabled!: () => void;
    const waiting = new Promise<void>((resolve) => {
      disabled = resolve;
    });
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
      daemonCommand: async (path, command, signal, timeout, maxBytes) => {
        const result = await existingDaemonCommand(path, command, signal, timeout, maxBytes);
        if (command.action === 'isenabled' && result.enabled === false) disabled();
        return result;
      },
    });
    try {
      await computer.act('closing', { action: 'open', url: origin });
      const fields = { number: '#password' };
      const destinations = await computer.cardDestinations('closing', fields);
      const outcome = computer
        .fillCard(
          {
            threadId: 'closing',
            fields,
            ...destinations,
            card: {
              cardNumber: '4111111111111111',
              expiryMonth: 12,
              expiryYear: 2099,
              cardholder: 'Synthetic owner',
            },
            submitSelector: '#submit',
          },
          controller.signal,
        )
        .then(
          () => true,
          () => false,
        );
      await waiting;
      controller.abort();
      const submitted = await outcome;
      validated.resolve();
      await enabled.promise;
      await delay(300);
      assert.equal(submitted, false);
      assert.equal(submissions, 0);
      await computer.act('closing', { action: 'reload' });
      assert.equal((await computer.currentPage('closing')).origin, origin);
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'private submission refuses disabled or changed targets and preserves query errors',
  { timeout: 60_000 },
  async () => {
    let submissions = 0;
    let mode: 'disabled' | 'early' | 'moving' | 'missing' = 'disabled';
    let interrupted = false;
    let failedQuery: unknown;
    let queries = 0;
    const secret = 'Synthetic disabled-submit password';
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/submit') {
        submissions++;
        response.end('<h1>Unexpected submission</h1>');
      } else if (request.url === '/changed') {
        response.end('<h1>Changed page</h1>');
      } else {
        response.end(`<h1>Private entry fixture</h1><form action="/submit" method="post"><input id="password" type="password"><button id="submit" disabled>Continue</button></form><script>
          document.querySelector('input').oninput=()=>{${request.url === '/early' ? "if (!window.moving) { window.moving=true; setTimeout(()=>location.assign('/changed'),500); }" : ''}};
        </script>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-private-disabled-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
      get submitReadyMs() {
        return mode === 'disabled' ? 300 : undefined;
      },
      daemonCommand: async (path, command, signal, timeout, maxBytes) => {
        if (command.action === 'isenabled' && command.selector === '#submit') {
          queries++;
          if ((mode === 'moving' || mode === 'missing') && !interrupted) {
            interrupted = true;
            if (mode === 'moving') {
              const connection = await existingDaemonCommand(path, { action: 'cdp_url' });
              const tabs = await existingDaemonCommand(path, { action: 'tab_list' });
              const tab = (tabs.tabs as { active: boolean; targetId: string }[]).find(
                (value) => value.active,
              )!;
              const probe = await openDevtools(String(connection.cdpUrl), tab.targetId);
              try {
                const before = await probe.document();
                await existingDaemonCommand(path, {
                  action: 'evaluate',
                  script: "setTimeout(() => location.assign('/changed'), 0)",
                });
                const deadline = performance.now() + 5000;
                while (
                  (await probe.document().catch(() => before)) === before &&
                  performance.now() < deadline
                )
                  await delay(20);
                assert.notEqual(await probe.document(), before);
              } finally {
                probe.close();
              }
            } else {
              await existingDaemonCommand(path, {
                action: 'evaluate',
                script: "document.querySelector('#submit').remove()",
              });
            }
          }
        }
        try {
          return await existingDaemonCommand(path, command, signal, timeout, maxBytes);
        } catch (error) {
          if (command.action === 'isenabled') failedQuery = error;
          throw error;
        }
      },
    });
    try {
      for (const value of ['disabled', 'early', 'moving', 'missing'] as const) {
        mode = value;
        interrupted = false;
        failedQuery = undefined;
        queries = 0;
        await computer.act('disabled', { action: 'open', url: `${origin}/${mode}` });
        await assert.rejects(
          computer.injectCredentials({
            threadId: 'disabled',
            origin,
            kind: 'password',
            password: secret,
            passwordSelector: '#password',
            submitSelector: '#submit',
          }),
          (error: unknown) => {
            if (mode === 'missing') {
              assert.ok(failedQuery);
              assert.equal(error, failedQuery);
            } else {
              assert.ok(
                error instanceof BrowserActionError,
                `Expected ${mode} refusal; received ${error instanceof Error ? error.constructor.name : typeof error}.`,
              );
              assert.equal(
                error.code,
                mode === 'disabled' ? 'browser_card_disabled' : 'browser_card_changed',
              );
            }
            assert.equal((error as Error).message.includes(secret), false);
            return true;
          },
        );
        assert.equal(submissions, 0);
        if (mode === 'moving' || mode === 'missing') assert.equal(queries, 1);
        if (mode === 'early' || mode === 'moving') {
          const page = await computer.act('disabled', { action: 'snapshot' });
          assert.match(page.text, /Changed page/);
          assert.equal(page.text.includes(secret), false);
        } else {
          await assert.rejects(
            computer.act('disabled', { action: 'snapshot' }),
            (error: unknown) =>
              error instanceof BrowserActionError && error.code === 'browser_card_paused',
          );
          await computer.act('disabled', { action: 'reload' });
          assert.match(
            (await computer.act('disabled', { action: 'snapshot' })).text,
            /Private entry fixture/,
          );
        }
      }
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'private submission keeps SPA state, delayed requests and field formats, and pauses scripts while a value stays',
  { timeout: 60_000 },
  async () => {
    const submitted = deferred<string>();
    const cardSubmitted = deferred<string>();
    let submissions = 0;
    let identifierSubmissions = 0;
    const server = createHttpServer(async (request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/record') {
        let body = '';
        for await (const bytes of request) body += bytes;
        submissions++;
        submitted.resolve(body);
        response.end('Accepted');
      } else if (request.url === '/identifier-record') {
        let body = '';
        for await (const bytes of request) body += bytes;
        assert.equal(body, 'synthetic@example.test');
        identifierSubmissions++;
        response.end('Accepted');
      } else if (request.url === '/card-record') {
        let body = '';
        for await (const bytes of request) body += bytes;
        cardSubmitted.resolve(body);
        response.end('Accepted');
      } else if (request.url === '/delayed') {
        response.end(`<input id="company"><input id="password" type="password"><button id="submit">Continue</button><script>
        document.querySelector('button').onclick = () => setTimeout(() => fetch('/record', { method: 'POST', body: JSON.stringify({company: document.querySelector('#company').value, password: document.querySelector('#password').value}) }), 300);
      </script>`);
      } else if (request.url === '/card') {
        response.end(
          '<h2>Order total EUR 30</h2><input id="number"><select id="month"><option value="">Choose month</option><option value="aug">August</option></select><input id="year"><input id="expiry"><button id="submit">Pay</button><script>document.querySelector("button").onclick = () => fetch("/card-record", {method:"POST", body:JSON.stringify({month:document.querySelector("#month").value, year:document.querySelector("#year").value, expiry:document.querySelector("#expiry").value})});</script>',
        );
      } else {
        response.end(`<button id="login">Log in</button><dialog><input id="username" aria-label="Email"><button id="submit" disabled>Continue</button></dialog><script>
        document.querySelector('#login').onclick = () => document.querySelector('dialog').showModal();
        document.querySelector('#username').${request.url === '/blur' ? 'onblur' : 'oninput'} = () => { clearTimeout(window.validation); document.querySelector('#submit').disabled = true; window.validation = setTimeout(() => document.querySelector('#submit').disabled = false, 800); };
        document.querySelector('#submit').onclick = async () => { await fetch('/identifier-record', {method: 'POST', body: document.querySelector('#username').value}); document.querySelector('dialog').innerHTML = '<h1>Password step</h1><input type="password" id="password">'; };
      </script>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-private-state-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    try {
      for (const trigger of ['input', 'blur']) {
        for (const refs of [false, true]) {
          const before = identifierSubmissions;
          await computer.act('state', {
            action: 'open',
            url: trigger === 'blur' ? `${origin}/blur` : origin,
          });
          await computer.act('state', { action: 'click', selector: '#login' });
          const page = (await computer.act('state', { action: 'snapshot' })).text;
          const ref = (name: string) => {
            const value = new RegExp(`"${name}"[^\\n]*ref=(e\\d+)`).exec(page)?.[1];
            assert.ok(value);
            return `@${value}`;
          };
          await computer.injectCredentials({
            threadId: 'state',
            origin,
            kind: 'identifier',
            username: 'synthetic@example.test',
            usernameSelector: refs ? ref('Email') : '#username',
            submitSelector: refs ? ref('Continue') : '#submit',
          });
          await computer.act('state', { action: 'wait', text: 'Password step' });
          assert.match((await computer.act('state', { action: 'snapshot' })).text, /Password step/);
          assert.equal(identifierSubmissions, before + 1);
        }
      }
      await computer.act('state', { action: 'open', url: `${origin}/delayed` });
      await computer.act('state', {
        action: 'fill',
        selector: '#company',
        text: 'Synthetic company',
      });
      await computer.act('state', { action: 'evaluate', script: 'document.title' });
      await computer.injectCredentials({
        threadId: 'state',
        origin,
        kind: 'password',
        password: 'Synthetic private value',
        passwordSelector: '#password',
        submitSelector: '#submit',
      });
      assert.deepEqual(JSON.parse(await submitted.promise), {
        company: 'Synthetic company',
        password: 'Synthetic private value',
      });
      assert.equal(submissions, 1);
      assert.equal(
        (await computer.act('state', { action: 'snapshot' })).text.includes(
          'Synthetic private value',
        ),
        false,
      );
      await assert.rejects(
        computer.act('state', {
          action: 'evaluate',
          script: 'Promise.resolve(document.querySelector("#password").value.length)',
        }),
        /scripts are paused/,
      );
      await computer.act('state', { action: 'open', url: `${origin}/card` });
      const fields = {
        number: '#number',
        expiryMonth: '#month',
        expiryYear: { selector: '#year', format: 'YY' },
        expiry: { selector: '#expiry', format: 'YYYY-MM' },
      };
      const bound = await computer.cardDestinations('state', fields);
      await computer.fillCard({
        threadId: 'state',
        ...bound,
        fields,
        submitSelector: '#submit',
        card: {
          cardNumber: '4242424242424242',
          expiryMonth: 8,
          expiryYear: 2030,
          cardholder: 'Synthetic owner',
        },
      });
      assert.deepEqual(JSON.parse(await cardSubmitted.promise), {
        month: 'aug',
        year: '30',
        expiry: '2030-08',
      });
      assert.match(
        (await computer.act('state', { action: 'snapshot' })).text,
        /Order total EUR 30/,
      );
      await assert.rejects(
        computer.act('state', {
          action: 'evaluate',
          script: 'document.querySelector("#number").value',
        }),
        /scripts are paused/,
      );
      await computer.act('fence', { action: 'open', url: `${origin}/card` });
      await computer.act('fence', {
        action: 'evaluate',
        script: 'globalThis.__nodScripted = false',
      });
      const restarted = createAgentBrowserComputer({
        dataRoot: directory,
        browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
        privateNetwork: true,
        headless: true,
      });
      try {
        assert.equal((await restarted.act('fence', { action: 'snapshot' })).url, `${origin}/card`);
        assert.equal(
          (await restarted.cardDestinations('fence', fields)).destinations.number,
          origin,
        );
      } finally {
        await restarted.dispose();
      }
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'native sign-in methods bind observed controls and refuse changed or repeated selections',
  { skip: process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true', timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'nod-method-native-'));
    const received: string[] = [];
    const cancelling = new AbortController();
    const cancelled = deferred();
    let cancelledMethod: string | undefined;
    const changes: Record<string, string> = {
      replaced: 'primary.replaceWith(primary.cloneNode(true))',
      renamed: "primary.textContent = 'Delete account'",
      accessibleName: "primary.setAttribute('aria-label', 'Delete account')",
      destination: "primary.form.action = '/other'",
      disabled: 'primary.disabled = true',
      hidden: "primary.style.display = 'none'",
      base: "document.querySelector('base').href = '/other/'",
      covered:
        "const cover=document.createElement('button');cover.style.cssText='position:fixed;inset:0;z-index:1000';cover.textContent='Cover';cover.onclick=()=>fetch('/covered',{method:'POST'});document.body.append(cover)",
      changedOnPress: "primary.addEventListener('mousedown',()=>primary.form.action='/other')",
      changedOnRelease: "primary.addEventListener('pointerup',()=>primary.form.action='/other')",
      removedOnRelease: "primary.addEventListener('mouseup',()=>primary.remove())",
    };
    const server = createHttpServer(async (request, response) => {
      if (request.url === '/pressed') {
        cancelling.abort();
        await cancelled.promise;
        response.end();
        return;
      }
      if (request.method === 'POST') {
        received.push(request.url!);
        response.writeHead(303, { location: '/done' });
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/moving-inner') {
        response.end(
          '<body style="margin:0"><form action="/selected" method="post"><button id="primary" style="width:400px;height:60px">Continue</button></form>',
        );
        return;
      }
      if (request.url === '/moving-frame') {
        response.end(
          `<iframe id="frame" style="position:fixed;left:100px;top:60px;width:600px;height:200px;border:0" src="http://localhost:${(server.address() as { port: number }).port}/moving-inner" onload="document.getElementById('ready').textContent='Frame ready'"></iframe><div id="cover" style="display:none;position:fixed;left:360px;top:60px;width:40px;height:60px;z-index:10"></div><p id="ready"></p>`,
        );
        return;
      }
      if (request.url === '/done') {
        response.end('<h1>Selected</h1>');
        return;
      }
      if (request.url?.startsWith('/initial-')) {
        const attributes: Record<string, string> = {
          '/initial-disabled': 'disabled',
          '/initial-hidden': 'hidden',
          '/initial-inert': 'inert',
        };
        response.end(
          `<button id="primary" ${attributes[request.url] ?? ''}>Continue</button><p id="plain">Plain text</p>`,
        );
        return;
      }
      if (request.url === '/scrolled' || request.url === '/scrolled-xy') {
        response.end(
          `<form action="/selected" method="post" style="margin:1800px 0 0 ${request.url === '/scrolled-xy' ? 1600 : 0}px"><button id="primary">Continue with Example</button></form><button id="change" onclick="const cover=document.createElement('div');cover.style.cssText='position:fixed;inset:0;z-index:1000';document.body.append(cover)">Cover control</button><button id="veil" onclick="const veil=document.createElement('div');veil.style.cssText='position:fixed;inset:0;z-index:1000;pointer-events:none';document.body.append(veil)">Veil control</button>`,
        );
        return;
      }
      if (
        ['/framed', '/foreign', '/duplicate', '/scaled-half', '/scaled-double'].includes(
          request.url!,
        )
      ) {
        const scaled = request.url!.startsWith('/scaled-');
        const source =
          request.url === '/foreign' || scaled
            ? `http://localhost:${(server.address() as { port: number }).port}/${scaled ? 'scaled-inner' : 'inner'}`
            : '/inner';
        const transform = scaled
          ? `transform:scale(${request.url === '/scaled-half' ? 0.5 : 2});transform-origin:top left;`
          : '';
        response.end(
          `
          ${request.url === '/duplicate' ? '<button id="primary">Continue with Example</button>' : ''}
          <iframe title="Sign in" src="${source}" onload="document.getElementById('frame-state').textContent='Frame ready'" style="width:700px;height:400px;margin:70px 100px;border:12px solid;${transform}"></iframe><button id="reload-frame" onclick="document.getElementById('frame-state').textContent='Loading frame';document.querySelector('iframe').contentWindow.location.reload()">Reload frame</button><p id="frame-state">Loading frame</p>`,
        );
        return;
      }
      if (request.url === '/twin' || request.url === '/twin-inner') {
        response.end(
          `<body style="margin:8px"><form action="/selected" method="post" style="margin:0"><button style="width:200px;height:40px">Continue with Example</button></form>${request.url === '/twin' ? `<div style="position:fixed;left:0;top:0;width:300px;height:60px"></div><iframe title="Sign in" src="/twin-inner" onload="document.getElementById('ready').textContent='Frame ready'" style="width:500px;height:300px;margin:150px 200px;border:0"></iframe><p id="ready"></p>` : ''}`,
        );
        return;
      }
      if (request.url === '/cancel') {
        response.end(
          '<form action="/selected" method="post"><button id="primary" onmousedown="const xhr=new XMLHttpRequest();xhr.open(\'POST\',\'/pressed\',false);xhr.send()">Continue with Example</button></form><button id="ordinary" onclick="if(event.isTrusted)fetch(\'/ordinary\',{method:\'POST\'})">Continue browsing</button>',
        );
        return;
      }
      const change = changes[request.url!.slice(1)] ?? '';
      const primary =
        request.url === '/image'
          ? '<input id="primary" type="image" onclick="if(!event.isTrusted)event.preventDefault()" alt="Continue with Example" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%2240%22%3E%3Crect width=%22240%22 height=%2240%22 fill=%22gray%22/%3E%3C/svg%3E">'
          : '<button id="primary" onclick="if(!event.isTrusted)event.preventDefault()"><span>Continue with Example</span></button>';
      response.end(
        `
        ${request.url === '/scaled-inner' ? '<script>addEventListener("pointermove",()=>{const xhr=new XMLHttpRequest();xhr.open("POST","/moved",false);xhr.send()},{once:true})</script>' : ''}
        <base href="/"><style>#primary{position:relative}#primary::after{content:"";position:absolute;inset:0}</style><form action="selected" method="post">${primary}<button id="alternate" formaction="/alternate">Use another account</button></form><a id="link" href="linked">Continue with Link</a><button id="change" onclick="${change}">Change control</button>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    let socketPath = '';
    let clickReceiptMs: number | undefined;
    const makeComputer = () => {
      const computer = createAgentBrowserComputer({
        dataRoot: directory,
        browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
        privateNetwork: true,
        headless: true,
        get clickReceiptMs() {
          return clickReceiptMs;
        },
        daemonCommand: async (path, command, signal, timeoutMs) => {
          socketPath = path;
          return existingDaemonCommand(path, command, signal, timeoutMs);
        },
      });
      const selectMethod = computer.selectSignInMethod!;
      computer.selectSignInMethod = async (id, input, signal) => {
        if (input.methodId === cancelledMethod)
          signal?.addEventListener('abort', () => cancelled.resolve(), { once: true });
        return selectMethod(id, input, signal);
      };
      return computer;
    };
    const worker = await harness({ computer: makeComputer });
    const client = worker.client(directory, { timeoutMs: 30_000 });
    const failures: Array<{ event: string; error: unknown; context?: Record<string, unknown> }> =
      [];
    const record = (event: string, error: unknown, context?: Record<string, unknown>) => {
      failures.push({ event, error, context });
    };
    const inspectMethods = client.signInMethods!;
    const selectMethod = client.selectSignInMethod!;
    client.signInMethods = (...args) => withFailureLog(record, () => inspectMethods(...args));
    client.selectSignInMethod = (...args) => withFailureLog(record, () => selectMethod(...args));
    const act = (input: BrowserAction) => client.act('fixture', input);
    const choices = [
      { label: 'Misleading label', selector: '#primary span' },
      { label: 'Another misleading label', selector: '#alternate' },
    ];
    try {
      for (const path of [
        '/initial-disabled',
        '/initial-hidden',
        '/initial-inert',
        '/initial-plain',
      ]) {
        await act({ action: 'open', url: origin + path });
        await assert.rejects(
          client.signInMethods!('fixture', origin, [
            { label: 'Ignored', selector: path === '/initial-plain' ? '#plain' : '#primary' },
          ]),
          (error: unknown) => {
            assert.ok(error instanceof BrowserActionError);
            assert.equal(error.code, 'browser_sign_in_choice');
            assert.equal(error.signInGuard, 'choice_ineligible');
            return true;
          },
        );
      }
      await act({ action: 'open', url: origin });
      await assert.rejects(
        client.signInMethods!('fixture', origin, [
          { label: 'picker-private@example.test/private-account', selector: '#primary' },
          { label: 'Second', selector: '#primary span' },
        ]),
        (error: unknown) => {
          assert.equal(Object(error).signInGuard, 'choice_duplicate');
          return true;
        },
      );
      const bound = await client.signInMethods!('fixture', origin, choices);
      assert.deepEqual(
        bound.methods.map(({ label }) => label),
        ['Continue with Example', 'Use another account'],
      );
      assert.deepEqual(bound.methods[0]!.page.submits, {
        method: 'POST',
        to: origin + '/selected',
      });
      assert.deepEqual(bound.methods[1]!.page.submits, {
        method: 'POST',
        to: origin + '/alternate',
      });
      const selection = { origin, document: bound.document, methodId: bound.methods[0]!.id };
      await assert.rejects(client.selectSignInMethod!('other', selection), (error: unknown) => {
        assert.equal(Object(error).signInGuard, 'browser_unavailable');
        return true;
      });
      await client.selectSignInMethod!('fixture', selection);
      await act({ action: 'wait', url: '**/done' });
      assert.deepEqual(received, ['/selected']);
      await assert.rejects(client.selectSignInMethod!('fixture', selection), (error: unknown) => {
        assert.equal(Object(error).signInGuard, 'selection_missing');
        return true;
      });
      await assert.rejects(
        client.selectSignInMethod!('fixture', { ...selection, methodId: bound.methods[1]!.id }),
      );
      for (const change of [...Object.keys(changes), 'navigation', 'origin', 'closed']) {
        await act({ action: 'open', url: origin + '/' + change });
        const stale = await client.signInMethods!('fixture', origin, choices);
        if (change === 'navigation') await act({ action: 'reload' });
        else if (change === 'closed') await client.close('fixture');
        else if (change !== 'origin') await act({ action: 'click', selector: '#change' });
        clickReceiptMs = change === 'removedOnRelease' ? 100 : undefined;
        await assert.rejects(
          client.selectSignInMethod!('fixture', {
            origin: change === 'origin' ? 'https://another.example' : origin,
            document: stale.document,
            methodId: stale.methods[0]!.id,
          }),
          (error: unknown) => {
            if (change === 'changedOnRelease')
              assert.equal(Object(error).signInGuard, 'click_guard_changed');
            if (change === 'removedOnRelease')
              assert.equal(Object(error).signInGuard, 'click_not_received');
            return true;
          },
        );
        assert.deepEqual(received, ['/selected']);
      }
      await act({ action: 'open', url: origin + '/base' });
      const linked = await client.signInMethods!('fixture', origin, [
        { label: 'Ignored', selector: '#link' },
      ]);
      await act({ action: 'click', selector: '#change' });
      await assert.rejects(
        client.selectSignInMethod!('fixture', {
          origin,
          document: linked.document,
          methodId: linked.methods[0]!.id,
        }),
      );
      assert.deepEqual(received, ['/selected']);
      await act({ action: 'open', url: origin });
      const snapshot = (await act({ action: 'snapshot' })).text;
      const ref = /button "Continue with Example"[^\n]*ref=(e\d+)/.exec(snapshot)?.[1];
      assert.ok(ref);
      const byRef = await client.signInMethods!('fixture', origin, [
        { label: 'Ignored', selector: '@' + ref },
      ]);
      assert.equal(byRef.methods[0]!.label, 'Continue with Example');
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '@e9999' }]),
        (error: unknown) => {
          assert.equal(Object(error).signInGuard, 'reference_missing');
          return true;
        },
      );
      await act({ action: 'open', url: origin + '/covered' });
      await act({ action: 'click', selector: '#change' });
      const covered = /button "Continue with Example"[^\n]*ref=(e\d+)/.exec(
        (await act({ action: 'snapshot' })).text,
      )?.[1];
      assert.ok(covered);
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '@' + covered }]),
      );
      await act({ action: 'open', url: origin + '/scrolled' });
      const veiled = [
        {
          label: 'Ignored',
          selector:
            '@' +
            /button "Continue with Example"[^\n]*ref=(e\d+)/.exec(
              (await act({ action: 'click', selector: '#veil' })).text,
            )?.[1],
        },
      ];
      assert.equal(
        (await client.signInMethods!('fixture', origin, veiled)).methods[0]!.label,
        'Continue with Example',
      );
      await act({ action: 'click', selector: '#change' });
      await assert.rejects(client.signInMethods!('fixture', origin, veiled), (error: unknown) => {
        assert.equal(Object(error).code, 'browser_click_intercepted');
        assert.equal(Object(error).signInGuard, 'control_covered');
        return true;
      });
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: 'button' }]),
        (error: unknown) => {
          assert.equal(Object(error).signInGuard, 'selector_rejected');
          return true;
        },
      );
      await act({ action: 'open', url: origin + '/duplicate' });
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '#primary' }]),
      );
      await act({ action: 'open', url: origin + '/twin' });
      await act({ action: 'wait', text: 'Frame ready' });
      const twin = /button "Continue with Example"[^\n]*ref=(e\d+)/.exec(
        (await act({ action: 'snapshot' })).text,
      )?.[1];
      assert.ok(twin);
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '@' + twin }]),
      );
      for (const path of ['/framed', '/foreign']) {
        await act({ action: 'open', url: origin + path });
        await act({ action: 'wait', text: 'Frame ready' });
        const inspect = () =>
          client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '#primary' }]);
        const framedRef = /button "Continue with Example"[^\n]*ref=(e\d+)/.exec(
          (await act({ action: 'snapshot' })).text,
        )?.[1];
        assert.ok(framedRef);
        const inspectRef = () =>
          client.signInMethods!('fixture', origin, [
            { label: 'Ignored', selector: '@' + framedRef },
          ]);
        if (path === '/foreign') {
          const refused = (error: unknown) =>
            error instanceof BrowserActionError && error.code === 'browser_sign_in_choice';
          await assert.rejects(inspect(), refused);
          await assert.rejects(inspectRef(), refused);
          await assert.rejects(
            client.signInMethods!('fixture', origin, [
              { label: 'Ignored', selector: '#frame-state' },
            ]),
            refused,
          );
          continue;
        }
        assert.equal((await inspectRef()).methods[0]!.label, 'Continue with Example');
        const framed = await inspect();
        assert.equal(framed.methods[0]!.label, 'Continue with Example');
        await act({ action: 'click', selector: '#reload-frame' });
        await act({ action: 'wait', text: 'Frame ready' });
        await assert.rejects(
          client.selectSignInMethod!('fixture', {
            origin,
            document: framed.document,
            methodId: framed.methods[0]!.id,
          }),
        );
        const refreshed = await inspect();
        assert.equal(refreshed.document, framed.document);
        await client.selectSignInMethod!('fixture', {
          origin,
          document: refreshed.document,
          methodId: refreshed.methods[0]!.id,
        });
        const deadline = Date.now() + 5000;
        while (received.length < 2 && Date.now() < deadline) await delay(10);
        assert.deepEqual(received, ['/selected', '/selected']);
      }
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(client.selectSignInMethod!('fixture', selection, controller.signal));
      assert.deepEqual(received, ['/selected', '/selected']);
      await act({ action: 'open', url: origin + '/image' });
      const image = await client.signInMethods!('fixture', origin, [
        { label: 'Ignored', selector: '#primary' },
      ]);
      assert.equal(image.methods[0]!.label, 'Continue with Example');
      assert.deepEqual(image.methods[0]!.page.submits, {
        method: 'POST',
        to: origin + '/selected',
      });
      await client.selectSignInMethod!('fixture', {
        origin,
        document: image.document,
        methodId: image.methods[0]!.id,
      });
      await act({ action: 'wait', url: '**/done' });
      assert.deepEqual(received, ['/selected', '/selected', '/selected']);
      await assert.rejects(
        client.selectSignInMethod!('fixture', {
          origin,
          document: image.document,
          methodId: image.methods[0]!.id,
        }),
      );

      for (const [index, path] of ['/framed', '/foreign'].entries()) {
        await act({ action: 'open', url: origin + path });
        await act({ action: 'wait', text: 'Frame ready' });
        const connection = await existingDaemonCommand(socketPath, { action: 'cdp_url' });
        const tabs = await existingDaemonCommand(socketPath, { action: 'tab_list' });
        const tab = (tabs.tabs as { active: boolean; targetId: string }[]).find(
          (value) => value.active,
        )!;
        let inspector = await openDevtools(String(connection.cdpUrl), tab.targetId);
        try {
          const bound = await inspector.signInControl({ pixel: { x: 150, y: 100 } });
          assert.equal(
            bound.origin,
            path === '/foreign' ? `http://localhost:${address.port}` : origin,
          );
          assert.equal(bound.targetFrameId === bound.frameId, path === '/foreign');
          assert.notEqual(bound.loaderId, await inspector.document());
          if (path === '/framed') {
            const noInput = async (operation: () => Promise<unknown>) => {
              const inputs: string[] = [];
              const original = WebSocket.prototype.send;
              const staleSend = t.mock.method(
                WebSocket.prototype,
                'send',
                function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
                  const message = typeof data === 'string' ? JSON.parse(data) : undefined;
                  if (message?.method === 'Input.dispatchMouseEvent')
                    inputs.push(message.params.type);
                  original.call(this, data);
                },
              );
              try {
                await assert.rejects(operation());
              } finally {
                staleSend.mock.restore();
              }
              assert.deepEqual(inputs, []);
            };
            await noInput(() =>
              inspector.selectSignInControl({ ...bound, targetFrameId: 'synthetic-other-target' }),
            );
            await act({ action: 'click', selector: '#reload-frame' });
            await act({ action: 'wait', text: 'Frame ready' });
            await noInput(() => inspector.selectSignInControl(bound));
          }
          inspector.close();
          inspector = await openDevtools(String(connection.cdpUrl), tab.targetId);
          const current = await inspector.signInControl({ pixel: { x: 150, y: 100 } });
          inspector.close();
          inspector = await openDevtools(
            String(connection.cdpUrl),
            tab.targetId,
            undefined,
            path === '/framed' ? 2000 : undefined,
          );
          let delayed = false;
          let controlSession: string | undefined;
          const dispatched: string[] = [];
          let guardTimer: ReturnType<typeof setTimeout> | undefined;
          const originalSend = WebSocket.prototype.send;
          const sending = t.mock.method(
            WebSocket.prototype,
            'send',
            function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
              const message = typeof data === 'string' ? JSON.parse(data) : undefined;
              if (message?.method === 'DOM.getContentQuads') controlSession = message.sessionId;
              if (message?.method === 'Input.dispatchMouseEvent') {
                assert.ok(controlSession);
                assert.equal(message.sessionId, controlSession);
                dispatched.push(message.params.type);
              }
              if (
                path === '/framed' &&
                !delayed &&
                message?.method === 'Runtime.callFunctionOn' &&
                message.params?.functionDeclaration?.includes("globalThis[name + 'Guard'] = guard")
              ) {
                delayed = true;
                guardTimer = setTimeout(() => originalSend.call(this, data), 2400);
                return;
              }
              originalSend.call(this, data);
            },
          );
          try {
            await inspector.selectSignInControl(current);
          } finally {
            clearTimeout(guardTimer);
            sending.mock.restore();
          }
          assert.equal(delayed, path === '/framed');
          assert.deepEqual(dispatched, ['mouseMoved', 'mousePressed', 'mouseReleased']);
          const deadline = Date.now() + 5000;
          while (received.length < 4 + index && Date.now() < deadline) await delay(10);
          assert.deepEqual(received, Array(4 + index).fill('/selected'));
          await assert.rejects(inspector.selectSignInControl(current));
        } finally {
          inspector.close();
        }
      }
      for (const path of ['/scaled-half', '/scaled-double']) {
        await act({ action: 'open', url: origin + path });
        await act({ action: 'wait', text: 'Frame ready' });
        const connection = await existingDaemonCommand(socketPath, { action: 'cdp_url' });
        const tabs = await existingDaemonCommand(socketPath, { action: 'tab_list' });
        const tab = (tabs.tabs as { active: boolean; targetId: string }[]).find(
          (value) => value.active,
        )!;
        const inspector = await openDevtools(String(connection.cdpUrl), tab.targetId);
        try {
          const bound = await inspector.signInControl({ selector: '#primary' });
          await assert.rejects(inspector.selectSignInControl(bound));
          assert.deepEqual(received, Array(5).fill('/selected'));
        } finally {
          inspector.close();
        }
      }
      await act({ action: 'open', url: origin + '/cancel' });
      const interrupted = await client.signInMethods!('fixture', origin, [
        { label: 'Ignored', selector: '#primary' },
      ]);
      cancelledMethod = interrupted.methods[0]!.id;
      const interruptedSelection = {
        origin,
        document: interrupted.document,
        methodId: cancelledMethod,
      };
      await assert.rejects(
        client.selectSignInMethod!('fixture', interruptedSelection, cancelling.signal),
      );
      assert.equal(cancelling.signal.aborted, true);
      assert.deepEqual(received, Array(5).fill('/selected'));
      await assert.rejects(client.selectSignInMethod!('fixture', interruptedSelection));
      await assert.rejects(act({ action: 'click', selector: '#ordinary' }), /unavailable/);
      await act({ action: 'open', url: origin + '/cancel' });
      await act({ action: 'click', selector: '#ordinary' });
      const deadline = Date.now() + 5000;
      while (received.length < 6 && Date.now() < deadline) await delay(10);
      assert.deepEqual(received, [...Array(5).fill('/selected'), '/ordinary']);
      for (const path of ['/scrolled', '/scrolled-xy']) {
        await act({ action: 'open', url: origin + path });
        const ref = /button "Continue with Example"[^\n]*ref=(e\d+)/.exec(
          (await act({ action: 'snapshot' })).text,
        )?.[1];
        assert.ok(ref);
        const before = [...received];
        const bound = await client.signInMethods!('fixture', origin, [
          { label: 'Ignored', selector: '@' + ref },
        ]);
        assert.equal(bound.methods[0]!.label, 'Continue with Example');
        assert.deepEqual(
          (await client.currentPage!('fixture', { action: 'click', selector: '@' + ref })).submits,
          { method: 'POST', to: origin + '/selected' },
        );
        assert.deepEqual(received, before);
        const selection = { origin, document: bound.document, methodId: bound.methods[0]!.id };
        await client.selectSignInMethod!('fixture', selection);
        await act({ action: 'wait', url: '**/done' });
        assert.deepEqual(received, [...before, '/selected']);
        await assert.rejects(client.selectSignInMethod!('fixture', selection));
        await act({ action: 'open', url: origin + path });
        const covered = await client.signInMethods!('fixture', origin, [
          { label: 'Ignored', selector: '#primary' },
        ]);
        await act({ action: 'click', selector: '#change' });
        await assert.rejects(
          client.selectSignInMethod!('fixture', {
            origin,
            document: covered.document,
            methodId: covered.methods[0]!.id,
          }),
        );
        assert.deepEqual(received, [...before, '/selected']);
      }
      for (const covered of [false, true]) {
        let moved = false;
        await act({ action: 'open', url: origin + '/moving-frame' });
        await act({ action: 'wait', text: 'Frame ready' });
        const movingConnection = await existingDaemonCommand(socketPath, { action: 'cdp_url' });
        const movingTabs = await existingDaemonCommand(socketPath, { action: 'tab_list' });
        const movingTab = (movingTabs.tabs as { active: boolean; targetId: string }[]).find(
          (value) => value.active,
        )!;
        const movingInspector = await openDevtools(
          String(movingConnection.cdpUrl),
          movingTab.targetId,
        );
        const beforeMove = [...received];
        const movingInputs: string[] = [];
        let parentSession: string | undefined;
        let mutationError: unknown;
        let mutationTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const movingControl = await movingInspector.signInControl({ selector: '#primary' });
          const original = WebSocket.prototype.send;
          const sending = t.mock.method(
            WebSocket.prototype,
            'send',
            function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
              const message = typeof data === 'string' ? JSON.parse(data) : undefined;
              if (message?.method === 'DOM.getFrameOwner') parentSession = message.sessionId;
              if (message?.method === 'Input.dispatchMouseEvent') {
                movingInputs.push(message.params.type);
                if (message.params.type === 'mouseMoved' && !moved) {
                  assert.ok(parentSession);
                  const changed = (event: MessageEvent) => {
                    const response = JSON.parse(String(event.data));
                    if (response.id !== 900_000_001) return;
                    clearTimeout(mutationTimer);
                    this.removeEventListener('message', changed);
                    if (
                      response.error ||
                      response.result?.exceptionDetails ||
                      response.result?.result?.value !== true
                    ) {
                      mutationError = new Error('The parent frame mutation failed.');
                      movingInspector.close();
                      return;
                    }
                    moved = true;
                    original.call(this, data);
                  };
                  this.addEventListener('message', changed);
                  mutationTimer = setTimeout(() => {
                    this.removeEventListener('message', changed);
                    mutationError = new Error('The parent frame mutation did not answer.');
                    movingInspector.close();
                  }, 2000);
                  original.call(
                    this,
                    JSON.stringify({
                      id: 900_000_001,
                      method: 'Runtime.evaluate',
                      sessionId: parentSession,
                      params: {
                        expression: `(() => { const frame=document.getElementById('frame');const cover=document.getElementById('cover');frame.style.left='180px';cover.style.display='${covered ? 'block' : 'none'}';return frame.getBoundingClientRect().left===180 && document.elementFromPoint(300,90)===frame && document.elementFromPoint(380,90)===${covered ? 'cover' : 'frame'}; })()`,
                        returnByValue: true,
                      },
                    }),
                  );
                  return;
                }
              }
              original.call(this, data);
            },
          );
          try {
            const refusal = await movingInspector.selectSignInControl(movingControl).then(
              () => undefined,
              (error: unknown) => error,
            );
            t.diagnostic(
              `Moved control result: ${refusal instanceof Error ? `${refusal.name}: ${refusal.message}` : String(refusal)}; guard: ${String(Object(refusal).signInGuard)}; input: ${movingInputs.join(',')}.`,
            );
            assert.equal(mutationError, undefined);
            assert.equal(moved, true);
            if (covered) {
              assert.equal(Object(refusal).signInGuard, 'control_covered');
            } else {
              assert.equal(refusal, undefined);
              const deadline = Date.now() + 500;
              while (received.length === beforeMove.length && Date.now() < deadline)
                await delay(10);
            }
          } finally {
            clearTimeout(mutationTimer);
            sending.mock.restore();
            t.diagnostic(
              `Frame moved: ${moved}; covered: ${covered}; new submissions: ${received.length - beforeMove.length}.`,
            );
          }
          assert.equal(moved, true);
          assert.deepEqual(
            movingInputs,
            covered ? ['mouseMoved'] : ['mouseMoved', 'mousePressed', 'mouseReleased'],
          );
          assert.deepEqual(received, covered ? beforeMove : [...beforeMove, '/selected']);
        } finally {
          movingInspector.close();
        }
      }
      const guards = failures.map((failure) => failure.context?.signInGuard);
      for (const guard of [
        'choice_duplicate',
        'browser_unavailable',
        'selection_missing',
        'selection_origin_changed',
        'document_changed',
        'reference_missing',
        'selector_rejected',
        'control_changed',
        'control_covered',
        'frame_changed',
      ])
        assert.ok(guards.includes(guard), `The native report did not keep ${guard}.`);
      assert.ok(!JSON.stringify(failures).includes('picker-private@example.test'));
    } finally {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
