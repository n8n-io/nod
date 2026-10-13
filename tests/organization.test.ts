import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { reportingCycle } from '../src/shared/organization.ts';
import { createOrganization, type OrgTurn } from '../src/server/organization.ts';

function outcome(value: unknown) {
  return value && typeof value === 'object' && 'status' in value ? value.status : undefined;
}

test('a reporting line can fan in and cannot loop', () => {
  const chief = '00000000-0000-4000-8000-000000000001';
  const ada = '00000000-0000-4000-8000-000000000002';
  const bo = '00000000-0000-4000-8000-000000000003';
  const links = [
    { agentId: ada, reportsTo: [chief] },
    { agentId: bo, reportsTo: [chief] },
  ];
  assert.equal(reportingCycle(ada, [chief, bo], links), false);
  assert.equal(reportingCycle(chief, [ada], links), true);
  assert.equal(reportingCycle(chief, [chief], links), true);
});

test(
  'organization dossiers stay owner scoped, helpers stay detached, and a cap stops the agent',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `org_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: url.href });
    try {
      await pool.query(`
        CREATE TABLE turns (id uuid PRIMARY KEY);
        CREATE TABLE preferences (owner_id text PRIMARY KEY, time_zone text);
        CREATE TABLE model_usage (
          id text PRIMARY KEY,
          owner_id text NOT NULL,
          turn_id uuid,
          cost_usd double precision,
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const owner = createOrganization({ pool, ownerId: 'owner-a' });
      const other = createOrganization({ pool, ownerId: 'owner-b' });
      await owner.initialize();
      const chief = await owner.create({
        name: 'Ada Chief',
        kind: 'chief',
        brief: 'Assembles the round.',
        monthlyUsd: null,
      });
      const person = await owner.create({
        name: 'Bo Report',
        kind: 'person',
        brief: 'One person.',
        monthlyUsd: 1,
      });
      const helper = await owner.create({
        name: 'Numbers',
        kind: 'helper',
        brief: 'Pulls figures.',
        monthlyUsd: null,
      });
      await owner.setReports(person.id, { reportsTo: [chief.id] });
      await assert.rejects(
        () => owner.setReports(helper.id, { reportsTo: [chief.id] }),
        /no reporting line/,
      );
      await assert.rejects(
        () => owner.setReports(person.id, { reportsTo: [helper.id] }),
        /off the chart/,
      );
      await assert.rejects(
        () => owner.setReports(chief.id, { reportsTo: [person.id] }),
        /cannot loop/,
      );
      const chart = await owner.view();
      assert.deepEqual(chart.agents.find((agent) => agent.id === person.id)?.reportsTo, [chief.id]);
      assert.deepEqual(chart.agents.find((agent) => agent.id === chief.id)?.reporteeIds, [
        person.id,
      ]);
      assert.equal((await other.view()).agents.length, 0);
      await assert.rejects(() => other.dossier(person.id), /not on your chart/);

      const turnId = randomUUID();
      await pool.query('INSERT INTO turns(id) VALUES ($1)', [turnId]);
      const turn: OrgTurn = {
        threadId: randomUUID(),
        turnId,
        source: 'user',
        readOnly: false,
      };
      assert.equal(outcome(await owner.act(turn, 'focus', { id: person.id })), 'focused');
      await pool.query(
        `INSERT INTO model_usage(id, owner_id, turn_id, cost_usd) VALUES($1,$2,$3,$4)`,
        [randomUUID(), 'owner-a', turnId, 1],
      );
      assert.equal(
        outcome(
          await owner.act({ ...turn, turnId: randomUUID() }, 'note', {
            id: person.id,
            kind: 'evidence',
            title: 'Shipped',
            body: 'A fix.',
            link: null,
          }),
        ),
        'limit',
      );
      assert.equal(
        outcome(
          await owner.act({ ...turn, source: 'event' }, 'note', {
            id: chief.id,
            kind: 'note',
            title: 'Nope',
            body: 'Background.',
            link: null,
          }),
        ),
        'refused',
      );
      await owner.addEntry(person.id, {
        kind: 'draft',
        title: 'Round',
        body: 'Snapshot, three samples, what went well, one question.',
        link: 'https://example.com/thread',
      });
      const exported = await owner.exportOne(person.id);
      assert.equal(exported.agents[0]?.entries[0]?.title, 'Round');
      assert.equal(exported.agents[0]?.reportsTo[0], chief.id);
      assert.equal((await other.exportAll()).agents.length, 0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
