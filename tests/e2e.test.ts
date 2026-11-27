import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startNod } from './e2e-harness.ts';

test(
  'end to end, every request keeps its own work through bursts, steering, stops and a crash',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 240_000 },
  async (t) => {
    const nod = await startNod();
    t.after(() => nod.close());
    const results = async () =>
      nod.query<{ title: string; status: string; result: string }>(
        `SELECT t.title,t.state AS status,
           (SELECT string_agg(m.text, ' | ' ORDER BY m.created_at) FROM messages m JOIN turns u ON u.id=m.turn_id
            WHERE u.task_id=t.id AND m.role='assistant' AND m.text LIKE 'Done:%') AS result
         FROM tasks t ORDER BY t.created_at`,
      );

    await t.test('messages sent while the chat works each start their own task', async () => {
      const first = await nod.send('hold: plan the week');
      await nod.running('hold: plan the week');
      await nod.send('task: compare Lisbon hotels');
      await nod.send('task: write a packing list');
      await nod.send('task: research the Charles Bridge');
      await nod.release('hold: plan the week');
      await nod.settle();
      assert.deepEqual(
        (await results()).map(({ title, status, result }) => [title, status, result]),
        [
          ['compare Lisbon hotels', 'done', 'Done: task: compare Lisbon hotels'],
          ['write a packing list', 'done', 'Done: task: write a packing list'],
          ['research the Charles Bridge', 'done', 'Done: task: research the Charles Bridge'],
        ],
      );
      assert.ok(first.turnId);
      assert.deepEqual(await nod.violations(), []);
    });

    await t.test('a reply to a task reaches that task and no other', async () => {
      const { messages } = await nod.state();
      const hotels = messages.find((message) => message.text === 'Starting compare Lisbon hotels.');
      assert.ok(hotels);
      await nod.send('only near the metro', { replyTo: hotels.id });
      await nod.settle();
      const delivered = await nod.query<{ title: string }>(
        `SELECT t.title FROM turns u JOIN tasks t ON t.id=u.task_id JOIN messages m ON m.id=u.message_id
         WHERE m.text='only near the metro'`,
      );
      assert.deepEqual(delivered, [{ title: 'compare Lisbon hotels' }]);
      assert.deepEqual(await nod.violations(), []);
    });

    await t.test('Stop on one task leaves the others running', async () => {
      await nod.send('task: hold: watch the parcel');
      await nod.send('task: hold: check the train');
      const [parcel, train] = await Promise.all(
        ['hold: watch the parcel', 'hold: check the train'].map(async (title) => {
          await nod.until(
            async () =>
              (
                await nod.query(
                  "SELECT 1 FROM tasks t JOIN turns u ON u.task_id=t.id WHERE t.title=$1 AND u.status='running'",
                  [title],
                )
              ).length > 0,
          );
          return (
            await nod.query<{ id: string }>('SELECT id FROM tasks WHERE title=$1', [title])
          )[0]!;
        }),
      );
      await nod.stopTask(parcel!.id);
      await nod.release('task: hold: check the train');
      await nod.settle();
      const states = await nod.query<{ title: string; state: string }>(
        'SELECT title,state FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY created_at',
        [[parcel!.id, train!.id]],
      );
      assert.deepEqual(states, [
        { title: 'hold: watch the parcel', state: 'cancelled' },
        { title: 'hold: check the train', state: 'done' },
      ]);
    });

    await t.test(
      'a crash interrupts work once, says nothing changed, and a reply continues it',
      async () => {
        await nod.send('task: hold: draft the newsletter');
        await nod.until(
          async () =>
            (
              await nod.query(
                `SELECT 1 FROM tasks t JOIN turns u ON u.task_id=t.id
                 WHERE t.title='hold: draft the newsletter' AND u.status='running'
                   AND NOT EXISTS (SELECT 1 FROM turns o WHERE o.id<>u.id AND o.status IN ('queued','running'))`,
              )
            ).length > 0,
        );
        await nod.crash();
        await nod.restart();
        await nod.settle();
        const [interrupted] = await nod.query<{ status: string; error: string; notice: string }>(
          `SELECT u.status,u.error,(SELECT m.text FROM messages m WHERE m.turn_id=u.id AND m.role='assistant') AS notice
         FROM turns u JOIN tasks t ON t.id=u.task_id WHERE t.title='hold: draft the newsletter'`,
        );
        assert.equal(interrupted?.status, 'failed');
        assert.equal(interrupted?.error, 'Interrupted.');
        assert.match(interrupted?.notice ?? '', /Nothing was sent, submitted or deleted/);
        const { messages } = await nod.state();
        const notice = messages.find((message) => message.text === interrupted!.notice)!;
        await nod.release('task: hold: draft the newsletter');
        await nod.send('continue', { replyTo: notice.id });
        await nod.settle();
        const [task] = await nod.query<{ state: string; turns: number }>(
          `SELECT t.state,(SELECT count(*)::int FROM turns u WHERE u.task_id=t.id) AS turns
         FROM tasks t WHERE t.title='hold: draft the newsletter'`,
        );
        assert.deepEqual(task, { state: 'done', turns: 2 });
        assert.deepEqual(await nod.violations({ failed: 1 }), []);
      },
    );

    await t.test('a one-time schedule runs once at its time', async () => {
      const runAt = new Date(Date.now() + 2_000).toISOString();
      await nod.api('POST', '/api/schedules', {
        title: 'Stretch reminder',
        prompt: 'remind me to stretch',
        kind: 'once',
        runAt,
        timeZone: 'UTC',
      });
      await nod.until(
        async () =>
          (await nod.query("SELECT 1 FROM turns WHERE source='schedule' AND status='succeeded'"))
            .length > 0,
      );
      await nod.settle();
      const runs = await nod.query<{ started: string; text: string }>(
        `SELECT u.started_at::text AS started,
           (SELECT m.text FROM messages m WHERE m.turn_id=u.id AND m.role='assistant') AS text
         FROM turns u WHERE u.source='schedule'`,
      );
      assert.equal(runs.length, 1);
      assert.ok(Date.parse(runs[0]!.started) >= Date.parse(runAt));
      assert.match(runs[0]!.text, /remind me to stretch/);
      assert.deepEqual(await nod.violations({ failed: 1 }), []);
    });

    await t.test('quick questions are each answered', async () => {
      await nod.send('hold: think');
      await nod.running('hold: think');
      for (const question of ['what is 12 times 13', 'capital of Australia', 'thanks'])
        await nod.send(question);
      await nod.release('hold: think');
      await nod.settle();
      const { messages } = await nod.state();
      const replies = messages.filter((message) => message.role === 'assistant').map((m) => m.text);
      for (const question of ['what is 12 times 13', 'capital of Australia', 'thanks'])
        assert.ok(
          replies.some((reply) => reply.includes(`Answer: ${question}`)),
          question,
        );
      assert.deepEqual(await nod.violations({ failed: 1 }), []);
    });

    const notices = () =>
      nod.query<{ id: string; text: string; task: string | null }>(
        `SELECT m.id,m.text,(SELECT t.title FROM tasks t WHERE t.id=u.task_id) AS task
         FROM messages m JOIN turns u ON u.id=m.turn_id
         WHERE m.stream_id=concat('failure:',u.id) AND u.error='Interrupted.' ORDER BY m.created_at,m.id`,
      );
    const working = (title: string) =>
      nod.until(
        async () =>
          (
            await nod.query(
              `SELECT 1 FROM tasks t JOIN turns u ON u.task_id=t.id
               WHERE t.title=$1 AND u.status='running'
                 AND (SELECT count(*) FROM turns o WHERE o.status IN ('queued','running'))=2
                 AND EXISTS (SELECT 1 FROM turns o WHERE o.status='running' AND o.task_id IS NULL)`,
              [title],
            )
          ).length > 0,
      );

    await t.test(
      'a crash while the chat hands work to a task leaves one notice, on the task',
      async () => {
        const before = (await notices()).length;
        await nod.send('task: linger: hold: book the venue');
        await working('linger: hold: book the venue');
        await nod.crash();
        await nod.restart();
        await nod.settle();
        const [notice, ...more] = (await notices()).slice(before);
        assert.deepEqual(more, []);
        assert.equal(notice?.task, 'linger: hold: book the venue');
        assert.match(notice.text, /“linger: hold: book the venue”/);
        await nod.release('task: linger: hold: book the venue');
        await nod.send('continue', { replyTo: notice.id });
        await nod.settle();
        assert.deepEqual(await nod.violations({ failed: 3 }), []);
      },
    );

    await t.test(
      'a crash during a chat request and a task names which work each notice is about',
      async () => {
        const before = (await notices()).length;
        await nod.send('task: hold: order the cake');
        await nod.until(
          async () =>
            (
              await nod.query(
                `SELECT 1 FROM tasks t JOIN turns u ON u.task_id=t.id
               WHERE t.title='hold: order the cake' AND u.status='running'
                 AND (SELECT count(*) FROM turns o WHERE o.status IN ('queued','running'))=1`,
              )
            ).length > 0,
        );
        const question = await nod.send('hold: check the weather');
        await working('hold: order the cake');
        await nod.crash();
        await nod.restart();
        await nod.settle();
        const interrupted = (await notices()).slice(before);
        assert.deepEqual(interrupted.map((notice) => notice.task).sort(), [
          'hold: order the cake',
          null,
        ]);
        const chat = interrupted.find((notice) => !notice.task)!;
        const task = interrupted.find((notice) => notice.task)!;
        assert.match(task.text, /“hold: order the cake”/);
        assert.doesNotMatch(chat.text, /order the cake/);
        await nod.release('task: hold: order the cake');
        await nod.release('hold: check the weather');
        await nod.send('continue', { replyTo: task.id });
        await nod.send('go on', { replyTo: chat.id });
        await nod.settle();
        assert.equal(
          (await nod.query('SELECT 1 FROM turns WHERE message_id=$1', [question.messageId])).length,
          1,
        );
        assert.deepEqual(await nod.violations({ failed: 5 }), []);
      },
    );
  },
);

test(
  'end to end, turn traces and forget-reset exist only in dev mode',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 240_000 },
  async (t) => {
    for (const [nodeEnv, dev] of [
      ['production', false],
      ['test', false],
      ['development', true],
    ] as const)
      await t.test(nodeEnv, async () => {
        const nod = await startNod({ nodeEnv });
        try {
          const session = await nod.api<{ capabilities: { turnTraces?: boolean } }>(
            'GET',
            '/api/session',
          );
          assert.equal(session.capabilities.turnTraces, dev);
          const { turnId } = await nod.send('hello there');
          await nod.settle();
          const rows = await nod.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM model_call_traces',
          );
          assert.equal(rows[0]!.count > 0, dev);
          const routes = await Promise.all(
            ['/api/traces', `/api/turns/${turnId}/trace`].map((path) =>
              nod.api('GET', path).then(
                () => 200,
                (error: Error) => Number(/failed with (\d+)/.exec(error.message)?.[1]),
              ),
            ),
          );
          assert.deepEqual(routes, dev ? [200, 200] : [404, 404]);
          const { threadId } = await nod.state();
          const forget = await nod
            .api('POST', '/api/conversation/reset', { threadId, forget: true })
            .then(
              () => 200,
              (error: Error) => Number(/failed with (\d+)/.exec(error.message)?.[1]),
            );
          assert.equal(forget, dev ? 200 : 404);
          assert.deepEqual(await nod.violations(), []);
        } finally {
          await nod.close();
        }
      });
  },
);

test(
  'end to end, an earlier request covers every step of a task started from a short reply',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 },
  async (t) => {
    const nod = await startNod({ checker: true });
    t.after(() => nod.close());
    for (const title of ['Synthetic alpha', 'Synthetic beta', 'Synthetic gamma'])
      await nod.api('POST', '/api/schedules', {
        title,
        prompt: `Check ${title}.`,
        kind: 'recurring',
        cron: '0 9 * * *',
        timeZone: 'UTC',
      });
    await nod.send('Pause my synthetic alpha, beta and gamma schedules.');
    await nod.settle();
    await nod.send('task: pause-all go ahead');
    await nod.settle();
    assert.deepEqual(await nod.query('SELECT title,enabled FROM schedules ORDER BY title'), [
      { title: 'Synthetic alpha', enabled: false },
      { title: 'Synthetic beta', enabled: false },
      { title: 'Synthetic gamma', enabled: false },
    ]);
    assert.deepEqual(await nod.query('SELECT action,status FROM approvals'), []);
    assert.deepEqual(await nod.violations(), []);
  },
);

test(
  'end to end, a step nobody asked for still waits for the approval card',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 },
  async (t) => {
    const nod = await startNod({ checker: true });
    t.after(() => nod.close());
    await nod.api('POST', '/api/schedules', {
      title: 'Synthetic delta',
      prompt: 'Check Synthetic delta.',
      kind: 'recurring',
      cron: '0 9 * * *',
      timeZone: 'UTC',
    });
    await nod.send('task: pause-all go ahead');
    await nod.until(
      async () => (await nod.query("SELECT 1 FROM approvals WHERE status='pending'")).length === 1,
    );
    assert.deepEqual(await nod.query('SELECT enabled FROM schedules'), [{ enabled: true }]);
    const [card] = await nod.query<{ id: string; confirmation_message_id: string }>(
      "SELECT id,confirmation_message_id FROM approvals WHERE status='pending'",
    );
    const { threadId } = await nod.state();
    await nod.api('POST', '/api/messages', {
      text: 'Yes',
      threadId,
      clientMessageId: crypto.randomUUID(),
      replyToMessageId: card!.confirmation_message_id,
      approvalAnswer: { approvalId: card!.id, approved: true },
    });
    await nod.settle();
    assert.deepEqual(await nod.query('SELECT enabled FROM schedules'), [{ enabled: false }]);
    assert.deepEqual(await nod.query('SELECT action,status FROM approvals'), [
      { action: 'NOD_schedule_pause', status: 'completed' },
    ]);
    assert.deepEqual(await nod.violations(), []);
  },
);

test(
  'end to end, each bot keeps its own chat, session, tools and note while Nod keeps its own',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 240_000 },
  async (t) => {
    const nod = await startNod({ checker: true });
    t.after(() => nod.close());
    const chat = async (botId: string) =>
      (
        await nod.api<{
          messages: Array<{ id: string; role: string; text: string; botId?: string | null }>;
        }>('GET', `/api/bots/${botId}/messages`)
      ).messages;
    const model = { connectionId: randomUUID(), modelId: 'scripted', effort: 'medium' };
    const penny = await nod.api<{ id: string; name: string }>('POST', '/api/bots', {
      name: 'Penny',
      model,
    });
    await nod.api('PATCH', `/api/bots/${penny.id}`, { job: 'Track my bills' });

    await t.test(
      'a bot answers in its own chat and session with its note and the team',
      async () => {
        await nod.send('Nod-only: plan the week');
        const sent = await nod.send('check the electricity bill', { botId: penny.id });
        await nod.settle();
        assert.deepEqual(
          (await chat(penny.id)).map(({ role, text, botId }) => [role, text, botId]),
          [
            ['user', 'check the electricity bill', penny.id],
            [
              'assistant',
              `Penny: check the electricity bill | note team/${penny.id}.md | bots Penny`,
              penny.id,
            ],
          ],
        );
        assert.deepEqual(
          await nod.query('SELECT session_id FROM turns WHERE id=$1', [sent.turnId]),
          [{ session_id: penny.id }],
        );
        const main = (await nod.state()).messages.map(({ text }) => text);
        assert.ok(main.includes('Nod-only: plan the week'));
        assert.ok(!main.some((text) => text.includes('electricity')));
        const reply = (await chat(penny.id)).at(-1)!;
        await nod.api('POST', `/api/messages/${reply.id}/reaction`, { reaction: '👍' });
        await nod.settle();
        assert.deepEqual(
          await nod.query(
            "SELECT bot_id FROM turns WHERE starts_with(source_id,'reaction-reply:')",
          ),
          [{ bot_id: penny.id }],
        );
        assert.deepEqual(await nod.violations(), []);
      },
    );

    await t.test('a bot starts tasks and schedules that report back to its own chat', async () => {
      await nod.send('task: compare bills', { botId: penny.id });
      await nod.settle();
      assert.deepEqual(
        await nod.query("SELECT bot_id,state FROM tasks WHERE title='compare bills'"),
        [{ bot_id: penny.id, state: 'done' }],
      );
      await nod.send('schedule: water bill check', { botId: penny.id });
      await nod.until(
        async () =>
          (
            await nod.query(
              "SELECT 1 FROM turns WHERE source='schedule' AND bot_id=$1 AND status='succeeded'",
              [penny.id],
            )
          ).length > 0,
      );
      await nod.settle();
      assert.deepEqual(await nod.query('SELECT bot_id FROM schedules'), [{ bot_id: penny.id }]);
      const texts = (await chat(penny.id)).map(({ text }) => text);
      assert.ok(texts.includes('Starting compare bills.'));
      assert.ok(texts.includes('Done: task: compare bills'));
      assert.ok(texts.some((text) => text.includes('Scheduled task: water bill check')));
      const main = (await nod.state()).messages.map(({ text }) => text).join('\n');
      assert.doesNotMatch(main, /compare bills|water bill/);
      assert.deepEqual(await nod.violations(), []);
    });

    await t.test("a bot can't steer or stop Nod's tasks", async () => {
      await nod.send('task: plan the garden');
      await nod.settle();
      const [nodTask] = await nod.query<{ id: string }>(
        "SELECT id FROM tasks WHERE title='plan the garden' AND bot_id IS NULL",
      );
      await nod.send(`steer: ${nodTask!.id}`, { botId: penny.id });
      await nod.settle();
      assert.match((await chat(penny.id)).at(-1)!.text, /belongs to another chat/);
      assert.deepEqual(
        await nod.query("SELECT 1 FROM turns WHERE source='task' AND bot_id=$1 AND task_id=$2", [
          penny.id,
          nodTask!.id,
        ]),
        [],
      );
    });

    await t.test('asking Nod creates a bot through the bot tool and the trust check', async () => {
      await nod.send('make bot: Scout | Research trips');
      await nod.settle();
      const { bots, messages } = await nod.state();
      assert.deepEqual(
        bots.map(({ name, job }) => [name, job]),
        [
          ['Penny', 'Track my bills'],
          ['Scout', 'Research trips'],
        ],
      );
      assert.equal(messages.at(-1)?.text, 'Made Scout | note team/nod.md');
      assert.deepEqual(await nod.violations(), []);
    });

    await t.test('a bot renames itself with the bot tool', async () => {
      await nod.send('rename yourself: Pip', { botId: penny.id });
      await nod.settle();
      assert.equal((await nod.state()).bots.find(({ id }) => id === penny.id)?.name, 'Pip');
      assert.deepEqual(await nod.violations(), []);
    });

    await t.test("Nod's Stop leaves a working bot alone and the bot's Stop ends it", async () => {
      const held = await nod.send('hold: compare bills', { botId: penny.id });
      await nod.running('hold: compare bills');
      await nod.stopAll();
      assert.deepEqual(await nod.query('SELECT status FROM turns WHERE id=$1', [held.turnId]), [
        { status: 'running' },
      ]);
      await nod.stopBot(penny.id);
      await nod.settle();
      assert.deepEqual(await nod.query('SELECT status FROM turns WHERE id=$1', [held.turnId]), [
        { status: 'cancelled' },
      ]);
      const again = await nod.send('hold: compare bills again', { botId: penny.id });
      await nod.running('hold: compare bills again');
      await nod.api('POST', '/api/thread/stop', { all: true });
      await nod.settle();
      assert.deepEqual(await nod.query('SELECT status FROM turns WHERE id=$1', [again.turnId]), [
        { status: 'cancelled' },
      ]);
    });

    await t.test('a bot reads other chats but changes only its own', async () => {
      const scout = (await nod.state()).bots.find(({ name }) => name === 'Scout')!;
      const pip = await nod.api<{ id: string }>('POST', '/api/bots', { name: 'Quill', model });
      await nod.api('PATCH', `/api/bots/${scout.id}`, { instructions: 'Scout private rule' });
      const reply = async (text: string) => {
        await nod.send(text, { botId: pip.id });
        await nod.settle();
        return (await chat(pip.id)).at(-1)!.text;
      };
      const listed = await reply('call: bot {"action":"list"}');
      assert.match(listed, /Scout/);
      assert.doesNotMatch(listed, /Scout private rule/);
      assert.match(
        await reply(`call: bot {"action":"update","id":"${scout.id}","name":"Hacked"}`),
        /can change only itself/,
      );
      assert.equal((await nod.state()).bots.find(({ id }) => id === scout.id)?.name, 'Scout');
      await nod.send('schedule: water the plants', { botId: scout.id });
      await nod.settle();
      const [water] = await nod.query<{ id: string }>(
        "SELECT id FROM schedules WHERE title='water the plants'",
      );
      assert.ok(water);
      assert.doesNotMatch(
        await reply('call: nod {"action":"schedule_list","args":{}}'),
        /water the plants/,
      );
      assert.match(
        await reply(`call: nod {"action":"schedule_pause","args":{"id":"${water!.id}"}}`),
        /belongs to another chat/,
      );
      await nod.send('schedule: water the plants', { botId: pip.id });
      await nod.settle();
      assert.deepEqual(
        await nod.query(
          "SELECT bot_id FROM schedules WHERE title='water the plants' ORDER BY created_at",
        ),
        [{ bot_id: scout.id }, { bot_id: pip.id }],
      );
      const nodMessage = (await nod.state()).messages.find(({ role }) => role === 'user')!;
      assert.match(
        await reply(`call: send_message {"text":"hi","replyToMessageId":"${nodMessage.id}"}`),
        /belongs to another chat/,
      );
      assert.match(
        await reply(`call: task {"action":"stop","id":"${randomUUID()}"}`),
        /belongs to another chat/,
      );
      const saved = await nod.api<{ path: string }>('POST', '/api/memory/notes', {
        area: 'about',
        text: 'Lives in Barcelona.',
      });
      assert.match(
        await reply('call: memory {"action":"memory_find","args":{"query":"Barcelona"}}'),
        new RegExp(saved.path),
      );
      assert.match(
        await reply(`call: memory {"action":"memory_forget","args":{"path":"${saved.path}"}}`),
        /only your own notes/,
      );
      assert.ok(
        (await nod.api<{ notes: Array<{ path: string }> }>('GET', '/api/memory')).notes.some(
          (note) => note.path === saved.path,
        ),
      );
    });

    await t.test('removing a bot stops its chat and retires everything it left', async () => {
      const scout = (await nod.state()).bots.find(({ name }) => name === 'Scout')!;
      await nod.api('DELETE', `/api/bots/${scout.id}`);
      assert.deepEqual(
        (await nod.state()).bots.map(({ name }) => name),
        ['Pip', 'Quill'],
      );
      await assert.rejects(nod.send('are you there?', { botId: scout.id }), /404/);
      await assert.rejects(nod.api('DELETE', '/api/bots/nod'), /400/);
      await assert.rejects(nod.api('POST', '/api/bots', { name: ' NOD ', model }), /409/);
      await nod.until(
        async () =>
          (await nod.query('SELECT 1 FROM bots WHERE id=$1 AND retired_at IS NOT NULL', [scout.id]))
            .length > 0,
      );
      assert.deepEqual(await nod.query('SELECT id FROM schedules WHERE bot_id=$1', [scout.id]), []);
    });
  },
);
