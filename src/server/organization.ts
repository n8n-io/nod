import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  orgEntryKinds,
  orgKinds,
  reportingCycle,
  type OrgAgentSummary,
  type OrgCounts,
  type OrgDossier,
  type OrgEntry,
  type OrgExport,
  type OrgKind,
  type OrgView,
} from '../shared/organization.ts';

const agentCap = 40;
const entryCap = 400;
const readLimit = 40;
const zone = `COALESCE((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC')`;
const monthStart = `(date_trunc('month', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
const kindOrder: Record<OrgKind, number> = { chief: 0, person: 1, upward: 2, helper: 3 };

const agentInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(orgKinds),
    brief: z.string().trim().max(4000).default(''),
    monthlyUsd: z.number().finite().gt(0).max(1_000_000).nullable().default(null),
  })
  .strict();
const reportsInput = z
  .object({
    reportsTo: z.array(z.uuid()).max(20),
  })
  .strict();
const entryInput = z
  .object({
    kind: z.enum(orgEntryKinds),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(8000),
    link: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .strict();

export interface OrgTurn {
  threadId: string;
  turnId: string;
  source: 'user' | 'schedule' | 'event' | 'resume';
  readOnly: boolean;
}

function fail(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

function emptyCounts(): OrgCounts {
  return { evidence: 0, draft: 0, note: 0 };
}

export function createOrganization({ pool, ownerId }: { pool: Pool; ownerId: string }) {
  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS org_agents (
        id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        name text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('chief','person','upward','helper')),
        brief text NOT NULL DEFAULT '',
        monthly_usd double precision CHECK (monthly_usd IS NULL OR monthly_usd > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS org_agents_owner ON org_agents(owner_id, name);
      CREATE TABLE IF NOT EXISTS org_reports (
        owner_id text NOT NULL,
        agent_id uuid NOT NULL REFERENCES org_agents(id) ON DELETE CASCADE,
        reports_to uuid NOT NULL REFERENCES org_agents(id) ON DELETE CASCADE,
        PRIMARY KEY (agent_id, reports_to),
        CHECK (agent_id <> reports_to)
      );
      CREATE INDEX IF NOT EXISTS org_reports_owner ON org_reports(owner_id, reports_to);
      CREATE TABLE IF NOT EXISTS org_entries (
        id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        agent_id uuid NOT NULL REFERENCES org_agents(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('evidence','draft','note')),
        title text NOT NULL,
        body text NOT NULL,
        link text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS org_entries_agent ON org_entries(owner_id, agent_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS org_turn_bindings (
        owner_id text NOT NULL,
        turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES org_agents(id) ON DELETE CASCADE,
        PRIMARY KEY (owner_id, turn_id)
      );
    `);
  }

  async function owned(id: string) {
    const row = (
      await pool.query(`SELECT id, kind FROM org_agents WHERE id=$1 AND owner_id=$2`, [id, ownerId])
    ).rows[0] as { id: string; kind: OrgKind } | undefined;
    if (!row) throw fail('That agent is not on your chart.', 404);
    return row;
  }

  async function spendByAgent() {
    const { rows } = await pool.query<{ agent_id: string; spent: number; unpriced: number }>(
      `SELECT b.agent_id,
         COALESCE(SUM(u.cost_usd) FILTER (WHERE u.cost_usd IS NOT NULL),0)::float8 AS spent,
         COUNT(*) FILTER (WHERE u.cost_usd IS NULL)::int AS unpriced
       FROM org_turn_bindings b
       JOIN model_usage u ON u.turn_id=b.turn_id AND u.owner_id=b.owner_id
       WHERE b.owner_id=$1 AND u.created_at>=${monthStart}
       GROUP BY b.agent_id`,
      [ownerId],
    );
    return new Map(rows.map((row) => [row.agent_id, row]));
  }

  async function summaries(): Promise<OrgAgentSummary[]> {
    const [agents, links, entries, spend] = await Promise.all([
      pool.query<{
        id: string;
        name: string;
        kind: OrgKind;
        brief: string;
        monthly_usd: number | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, name, kind, brief, monthly_usd, created_at, updated_at
         FROM org_agents WHERE owner_id=$1`,
        [ownerId],
      ),
      pool.query<{ agent_id: string; reports_to: string }>(
        `SELECT agent_id, reports_to FROM org_reports WHERE owner_id=$1`,
        [ownerId],
      ),
      pool.query<{
        agent_id: string;
        kind: OrgEntry['kind'];
        count: number;
        first_at: Date | null;
        last_at: Date | null;
      }>(
        `SELECT agent_id, kind, count(*)::int AS count, min(created_at) AS first_at, max(created_at) AS last_at
         FROM org_entries WHERE owner_id=$1 GROUP BY agent_id, kind`,
        [ownerId],
      ),
      spendByAgent(),
    ]);
    const reports = new Map<string, string[]>();
    const reportees = new Map<string, string[]>();
    for (const link of links.rows) {
      reports.set(link.agent_id, [...(reports.get(link.agent_id) ?? []), link.reports_to]);
      reportees.set(link.reports_to, [...(reportees.get(link.reports_to) ?? []), link.agent_id]);
    }
    const counts = new Map<string, OrgCounts>();
    const first = new Map<string, string>();
    const last = new Map<string, string>();
    for (const row of entries.rows) {
      const current = counts.get(row.agent_id) ?? emptyCounts();
      current[row.kind] = row.count;
      counts.set(row.agent_id, current);
      const opened = row.first_at?.toISOString();
      const closed = row.last_at?.toISOString();
      if (opened && (!first.has(row.agent_id) || opened < first.get(row.agent_id)!))
        first.set(row.agent_id, opened);
      if (closed && (!last.has(row.agent_id) || closed > last.get(row.agent_id)!))
        last.set(row.agent_id, closed);
    }
    return agents.rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        brief: row.brief,
        monthlyUsd: row.monthly_usd,
        spentUsd: spend.get(row.id)?.spent ?? 0,
        unpriced: spend.get(row.id)?.unpriced ?? 0,
        reportsTo: (reports.get(row.id) ?? []).sort(),
        reporteeIds: (reportees.get(row.id) ?? []).sort(),
        counts: counts.get(row.id) ?? emptyCounts(),
        firstEntryAt: first.get(row.id) ?? null,
        lastEntryAt: last.get(row.id) ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }))
      .sort(
        (a, b) =>
          kindOrder[a.kind] - kindOrder[b.kind] ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
  }

  async function view(): Promise<OrgView> {
    return { agents: await summaries() };
  }

  async function entries(agentId: string): Promise<OrgEntry[]> {
    const { rows } = await pool.query<{
      id: string;
      kind: OrgEntry['kind'];
      title: string;
      body: string;
      link: string | null;
      created_at: Date;
    }>(
      `SELECT id, kind, title, body, link, created_at FROM org_entries
       WHERE owner_id=$1 AND agent_id=$2 ORDER BY created_at DESC, id DESC`,
      [ownerId, agentId],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async function dossier(id: string): Promise<OrgDossier> {
    await owned(id);
    const agent = (await summaries()).find((item) => item.id === id);
    if (!agent) throw fail('That agent is not on your chart.', 404);
    return { ...agent, entries: await entries(id) };
  }

  async function links() {
    const { rows } = await pool.query<{ agent_id: string; reports_to: string }>(
      `SELECT agent_id, reports_to FROM org_reports WHERE owner_id=$1`,
      [ownerId],
    );
    const grouped = new Map<string, string[]>();
    for (const row of rows)
      grouped.set(row.agent_id, [...(grouped.get(row.agent_id) ?? []), row.reports_to]);
    return [...grouped].map(([agentId, reportsTo]) => ({ agentId, reportsTo }));
  }

  async function create(raw: unknown) {
    const input = agentInput.parse(raw);
    const count = Number(
      (
        await pool.query(`SELECT count(*)::int AS count FROM org_agents WHERE owner_id=$1`, [
          ownerId,
        ])
      ).rows[0].count,
    );
    if (count >= agentCap) throw fail(`The chart holds ${agentCap} agents.`, 409);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO org_agents(id, owner_id, name, kind, brief, monthly_usd) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, ownerId, input.name, input.kind, input.brief, input.monthlyUsd],
    );
    return { id };
  }

  async function update(id: string, raw: unknown) {
    const current = await owned(id);
    const input = agentInput.parse(raw);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE org_agents SET name=$3, kind=$4, brief=$5, monthly_usd=$6, updated_at=now()
         WHERE id=$1 AND owner_id=$2`,
        [id, ownerId, input.name, input.kind, input.brief, input.monthlyUsd],
      );
      if (input.kind === 'helper' && current.kind !== 'helper')
        await client.query(
          `DELETE FROM org_reports WHERE owner_id=$1 AND (agent_id=$2 OR reports_to=$2)`,
          [ownerId, id],
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { ok: true as const };
  }

  async function setReports(id: string, raw: unknown) {
    const agent = await owned(id);
    if (agent.kind === 'helper') throw fail('A helper has no reporting line.', 409);
    const reportsTo = [...new Set(reportsInput.parse(raw).reportsTo)];
    if (reportsTo.includes(id) || reportingCycle(id, reportsTo, await links()))
      throw fail('A reporting line cannot loop back to the same agent.', 409);
    if (reportsTo.length) {
      const { rows } = await pool.query<{ id: string; kind: OrgKind }>(
        `SELECT id, kind FROM org_agents WHERE owner_id=$1 AND id = ANY($2::uuid[])`,
        [ownerId, reportsTo],
      );
      if (rows.length !== reportsTo.length) throw fail('Choose managers from this chart.', 400);
      if (rows.some((row) => row.kind === 'helper'))
        throw fail('A helper stays off the chart.', 409);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM org_reports WHERE owner_id=$1 AND agent_id=$2`, [
        ownerId,
        id,
      ]);
      for (const manager of reportsTo)
        await client.query(
          `INSERT INTO org_reports(owner_id, agent_id, reports_to) VALUES($1,$2,$3)`,
          [ownerId, id, manager],
        );
      await client.query(`UPDATE org_agents SET updated_at=now() WHERE id=$1 AND owner_id=$2`, [
        id,
        ownerId,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { ok: true as const };
  }

  async function remove(id: string) {
    await owned(id);
    await pool.query(`DELETE FROM org_agents WHERE id=$1 AND owner_id=$2`, [id, ownerId]);
    return { ok: true as const };
  }

  async function overLimit(id: string) {
    const agent = (await summaries()).find((item) => item.id === id);
    if (!agent) throw fail('That agent is not on your chart.', 404);
    if (agent.monthlyUsd !== null && agent.spentUsd >= agent.monthlyUsd)
      return {
        status: 'limit' as const,
        spentUsd: agent.spentUsd,
        monthlyUsd: agent.monthlyUsd,
        message:
          "This agent's monthly limit is reached. Raise it on the Organization page to keep going.",
      };
    return null;
  }

  async function addEntry(id: string, raw: unknown) {
    await owned(id);
    const input = entryInput.parse(raw);
    const count = Number(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM org_entries WHERE owner_id=$1 AND agent_id=$2`,
          [ownerId, id],
        )
      ).rows[0].count,
    );
    if (count >= entryCap)
      throw fail(
        `This dossier holds ${entryCap} entries. Export it and remove some before adding more.`,
        409,
      );
    const entryId = randomUUID();
    await pool.query(
      `INSERT INTO org_entries(id, owner_id, agent_id, kind, title, body, link) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [entryId, ownerId, id, input.kind, input.title, input.body, input.link],
    );
    await pool.query(`UPDATE org_agents SET updated_at=now() WHERE id=$1 AND owner_id=$2`, [
      id,
      ownerId,
    ]);
    return { id: entryId };
  }

  async function removeEntry(agentId: string, entryId: string) {
    await owned(agentId);
    const deleted = await pool.query(
      `DELETE FROM org_entries WHERE id=$1 AND agent_id=$2 AND owner_id=$3`,
      [entryId, agentId, ownerId],
    );
    if (!deleted.rowCount) throw fail('That entry is not in this dossier.', 404);
    return { ok: true as const };
  }

  function writable(turn: OrgTurn) {
    return !turn.readOnly && turn.source !== 'event';
  }

  async function act(turn: OrgTurn, action: string, args: Record<string, unknown>) {
    if (action === 'list') {
      const agents = await summaries();
      return agents.map((agent) => ({ ...agent, brief: agent.brief.slice(0, 240) }));
    }
    const parsedId = z.uuid().safeParse(args.id);
    if (!parsedId.success) throw new Error('Choose an agent from organization list.');
    const id = parsedId.data;
    if (action === 'read') {
      const full = await dossier(id);
      return { ...full, entries: full.entries.slice(0, readLimit) };
    }
    if (!writable(turn))
      return {
        status: 'refused' as const,
        message: 'This turn can read an organization dossier, not change it.',
      };
    if (action === 'focus') {
      const limited = await overLimit(id);
      if (limited) return limited;
      await pool.query(
        `INSERT INTO org_turn_bindings(owner_id, turn_id, agent_id) VALUES($1,$2,$3)
         ON CONFLICT (owner_id, turn_id) DO UPDATE SET agent_id=EXCLUDED.agent_id`,
        [ownerId, turn.turnId, id],
      );
      return { status: 'focused' as const, id };
    }
    if (action === 'note') {
      const limited = await overLimit(id);
      if (limited) return limited;
      const note = entryInput.safeParse(args);
      if (!note.success) throw new Error('A dossier note needs a title and a body.');
      const saved = await addEntry(id, note.data);
      return { status: 'saved' as const, id: saved.id };
    }
    throw fail('Unknown organization action.', 400);
  }

  async function exportAll(): Promise<OrgExport> {
    const agents = await summaries();
    return {
      exportedAt: new Date().toISOString(),
      agents: await Promise.all(
        agents.map(async (agent) => ({ ...agent, entries: await entries(agent.id) })),
      ),
    };
  }

  async function exportOne(id: string): Promise<OrgExport> {
    return { exportedAt: new Date().toISOString(), agents: [await dossier(id)] };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/organization', () => view());
    app.get('/api/organization/export', () => exportAll());
    app.post('/api/organization/agents', (request) => create(request.body));
    app.get<{ Params: { id: string } }>('/api/organization/agents/:id/export', (request) =>
      exportOne(request.params.id),
    );
    app.get<{ Params: { id: string } }>('/api/organization/agents/:id', (request) =>
      dossier(request.params.id),
    );
    app.post<{ Params: { id: string } }>('/api/organization/agents/:id', (request) =>
      update(request.params.id, request.body),
    );
    app.delete<{ Params: { id: string } }>('/api/organization/agents/:id', (request) =>
      remove(request.params.id),
    );
    app.post<{ Params: { id: string } }>('/api/organization/agents/:id/reports', (request) =>
      setReports(request.params.id, request.body),
    );
    app.post<{ Params: { id: string } }>('/api/organization/agents/:id/entries', (request) =>
      addEntry(request.params.id, request.body),
    );
    app.delete<{ Params: { agentId: string; entryId: string } }>(
      '/api/organization/agents/:agentId/entries/:entryId',
      (request) => removeEntry(request.params.agentId, request.params.entryId),
    );
  }

  return {
    initialize,
    view,
    dossier,
    create,
    update,
    setReports,
    remove,
    addEntry,
    removeEntry,
    act,
    exportAll,
    exportOne,
    registerRoutes,
  };
}
