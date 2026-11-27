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
