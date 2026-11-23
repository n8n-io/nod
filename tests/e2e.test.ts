import assert from 'node:assert/strict';
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
