import { useEffect, useState, type FormEvent } from 'react';
import { Download, Plus } from 'lucide-react';
import {
  orgEntryKinds,
  orgKinds,
  type OrgAgentSummary,
  type OrgDossier,
  type OrgEntryKind,
  type OrgExport,
  type OrgKind,
  type OrgView,
} from '../../shared/organization';
import { PageTitle } from '../components/page-title';
import { Button, Field, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage, post } from '../lib/api';
import { formatDateTime, useDateFormat } from '../lib/date-format';

const kindLabels: Record<OrgKind, string> = {
  chief: 'Chief of staff',
  person: 'Person',
  upward: 'Upward',
  helper: 'Helper',
};
const entryLabels: Record<OrgEntryKind, string> = {
  evidence: 'Evidence',
  draft: 'Draft',
  note: 'Note',
};

function safeLink(link: string) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function money(value: number) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
}

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function fileName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'agent'}.json`;
}

export function Organization({ onAsk }: { onAsk(text: string): void }) {
  const page = usePageData<OrgView>('/api/organization');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const agents = page.data?.agents ?? [];
  useEffect(() => {
    if (selected && page.data && !page.data.agents.some((agent) => agent.id === selected))
      setSelected(null);
  }, [page.data, selected]);
  return (
    <div className="content-page secondary-page organization-page">
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/organization" />
          <p>
            One assistant, one chart. Each agent is your dossier for a person. Otto does not speak
            as them, and nothing here writes to an app.
          </p>
        </div>
        <div className="secondary-heading-actions">
          <Button
            variant="outline"
            disabled={!agents.length}
            onClick={() =>
              void api<OrgExport>('/api/organization/export').then((value) =>
                download('organization.json', value),
              )
            }
          >
            <Download size={16} aria-hidden="true" />
            Export
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden="true" />
            Add agent
          </Button>
        </div>
      </header>
      {page.error && (
        <Notice>
          Could not load the chart.{' '}
          <Button variant="ghost" size="sm" onClick={() => void page.refresh()}>
            Try again
          </Button>
        </Notice>
      )}
      {!page.data && page.loading && <Loading label="Loading the chart…" />}
      {page.data && !agents.length && !creating && (
        <div className="secondary-empty">
          <h2>No one on the chart yet</h2>
          <p>
            Add the people you manage, and one dossier for your manager if you want that
            relationship kept too. Helpers stay off the chart.
          </p>
        </div>
      )}
      {creating && (
        <CreateAgent
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            setSelected(id);
            await page.refresh();
          }}
        />
      )}
      {agents.length > 0 && (
        <div className="organization-layout" data-analytics-private>
          <Chart agents={agents} selected={selected} onSelect={setSelected} />
          {selected && (
            <Dossier id={selected} agents={agents} onAsk={onAsk} onChanged={() => page.refresh()} />
          )}
        </div>
      )}
    </div>
  );
}

function Chart({
  agents,
  selected,
  onSelect,
}: {
  agents: OrgAgentSummary[];
  selected: string | null;
  onSelect(id: string): void;
}) {
  const onChart = agents.filter((agent) => agent.kind !== 'helper');
  const helpers = agents.filter((agent) => agent.kind === 'helper');
  const roots = onChart.filter((agent) => agent.reportsTo.length === 0);
  return (
    <div className="org-chart">
      <ul className="org-tree">
        <Branch
          agents={roots.length ? onChart : []}
          nodes={roots.length ? roots : onChart}
          selected={selected}
          trail={[]}
          onSelect={onSelect}
        />
      </ul>
      {helpers.length > 0 && (
        <section className="org-section">
          <h2>Off the chart</h2>
          <ul className="org-helpers">
            {helpers.map((agent) => (
              <li key={agent.id}>
                <Person agent={agent} selected={selected} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Branch({
  agents,
  nodes,
  selected,
  trail,
  onSelect,
}: {
  agents: OrgAgentSummary[];
  nodes: OrgAgentSummary[];
  selected: string | null;
  trail: string[];
  onSelect(id: string): void;
}) {
  return (
    <>
      {nodes.map((agent) => {
        const loop = trail.includes(agent.id);
        const children = agents.filter((item) => item.reportsTo.includes(agent.id));
        return (
          <li key={agent.id}>
            <Person agent={agent} selected={selected} onSelect={onSelect} />
            {!loop && children.length > 0 && (
              <ul>
                <Branch
                  agents={agents}
                  nodes={children}
                  selected={selected}
                  trail={[...trail, agent.id]}
                  onSelect={onSelect}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

function Person({
  agent,
  selected,
  onSelect,
}: {
  agent: OrgAgentSummary;
  selected: string | null;
  onSelect(id: string): void;
}) {
  return (
    <button
      type="button"
      className="org-person"
      aria-current={agent.id === selected}
      onClick={() => onSelect(agent.id)}
    >
      <span>{agent.name}</span>
      <small>{kindLabels[agent.kind]}</small>
    </button>
  );
}

function CreateAgent({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(id: string): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<OrgKind>('person');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await post<{ id: string }>('/api/organization/agents', {
        name,
        kind,
        brief: '',
        monthlyUsd: null,
      });
      await onCreated(created.id);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <form className="saved-plan org-form" onSubmit={(event) => void submit(event)}>
      <Field label="Name">
        <input
          className="input"
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Kind">
        <select
          className="input"
          value={kind}
          onChange={(event) => setKind(event.target.value as OrgKind)}
        >
          {orgKinds.map((value) => (
            <option key={value} value={value}>
              {kindLabels[value]}
            </option>
          ))}
        </select>
      </Field>
      {error && <Notice>{error}</Notice>}
      <div className="org-actions">
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Dossier({
  id,
  agents,
  onAsk,
  onChanged,
}: {
  id: string;
  agents: OrgAgentSummary[];
  onAsk(text: string): void;
  onChanged(): Promise<unknown>;
}) {
  const format = useDateFormat();
  const [dossier, setDossier] = useState<OrgDossier | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancel = false;
    setDossier(null);
    setError('');
    api<OrgDossier>(`/api/organization/agents/${id}`)
      .then((value) => {
        if (!cancel) setDossier(value);
      })
      .catch((cause) => {
        if (!cancel) setError(errorMessage(cause));
      });
    return () => {
      cancel = true;
    };
  }, [id, revision]);
  const reload = async () => {
    setRevision((current) => current + 1);
    await onChanged();
  };
  if (error) return <Notice>{error}</Notice>;
  if (!dossier) return <Loading label="Loading the dossier…" />;
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const total = dossier.counts.evidence + dossier.counts.draft + dossier.counts.note;
  return (
    <div className="org-dossier">
      <article className="saved-plan">
        <div className="saved-plan-title">
          <h2>{dossier.name}</h2>
          <span>{kindLabels[dossier.kind]}</span>
        </div>
        <Editor dossier={dossier} agents={agents} onSaved={reload} />
        <dl className="org-insights">
          <div>
            <dt>This month</dt>
            <dd>
              {dossier.monthlyUsd === null
                ? `${money(dossier.spentUsd)} spent, no cap`
                : `${money(dossier.spentUsd)} of ${money(dossier.monthlyUsd)}`}
            </dd>
          </div>
          <div>
            <dt>Dossier</dt>
            <dd>
              {total
                ? `${dossier.counts.evidence} evidence, ${dossier.counts.draft} drafts, ${dossier.counts.note} notes`
                : 'Nothing stored yet'}
            </dd>
          </div>
          {dossier.firstEntryAt && (
            <div>
              <dt>Kept since</dt>
              <dd>{formatDateTime(dossier.firstEntryAt, format)}</dd>
            </div>
          )}
          <div>
            <dt>Reports to</dt>
            <dd>
              {dossier.reportsTo.length
                ? dossier.reportsTo.map((manager) => names.get(manager) ?? 'Unknown').join(', ')
                : 'Nobody'}
            </dd>
          </div>
          <div>
            <dt>Reportees</dt>
            <dd>
              {dossier.reporteeIds.length
                ? dossier.reporteeIds.map((report) => names.get(report) ?? 'Unknown').join(', ')
                : 'Nobody'}
            </dd>
          </div>
        </dl>
        {dossier.unpriced > 0 && (
          <p className="org-meta">
            {dossier.unpriced} model {dossier.unpriced === 1 ? 'call has' : 'calls have'} no price
            yet, so {dossier.unpriced === 1 ? 'it is' : 'they are'} not in the spent amount.
          </p>
        )}
        <div className="org-actions">
          <Button
            onClick={() =>
              onAsk(
                `Read the organization dossier for ${dossier.name} before you do anything else. Use what is stored there, then check my connected apps for evidence. Draft the next entry in my voice: a snapshot ranked only against the other people on my chart, three random samples, what went well with the link first, and one growth question. Save the draft on that dossier. Do not write to any app.`,
              )
            }
          >
            Ask Otto
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void api<OrgExport>(`/api/organization/agents/${dossier.id}/export`).then((value) =>
                download(fileName(dossier.name), value),
              )
            }
          >
            <Download size={16} aria-hidden="true" />
            Export
          </Button>
        </div>
      </article>
      <EntryForm agentId={dossier.id} onSaved={reload} />
      <div className="org-entries">
        {dossier.entries.map((entry) => (
          <article key={entry.id} className="saved-plan org-entry">
            <header>
              <h3>{entry.title}</h3>
              <small>{entryLabels[entry.kind]}</small>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void api(`/api/organization/agents/${dossier.id}/entries/${entry.id}`, {
                    method: 'DELETE',
                  }).then(reload)
                }
              >
                Remove
              </Button>
            </header>
            <p className="org-meta">{formatDateTime(entry.createdAt, format)}</p>
            {entry.link &&
              (safeLink(entry.link) ? (
                <a href={safeLink(entry.link)!} target="_blank" rel="noreferrer">
                  {entry.link}
                </a>
              ) : (
                <p>{entry.link}</p>
              ))}
            <p>{entry.body}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function Editor({
  dossier,
  agents,
  onSaved,
}: {
  dossier: OrgDossier;
  agents: OrgAgentSummary[];
  onSaved(): Promise<unknown>;
}) {
  const [name, setName] = useState(dossier.name);
  const [kind, setKind] = useState(dossier.kind);
  const [brief, setBrief] = useState(dossier.brief);
  const [monthly, setMonthly] = useState(
    dossier.monthlyUsd === null ? '' : String(dossier.monthlyUsd),
  );
  const [reportsTo, setReportsTo] = useState(dossier.reportsTo);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setName(dossier.name);
    setKind(dossier.kind);
    setBrief(dossier.brief);
    setMonthly(dossier.monthlyUsd === null ? '' : String(dossier.monthlyUsd));
    setReportsTo(dossier.reportsTo);
    setConfirmDelete(false);
    setError('');
  }, [dossier]);
  const managers = agents.filter((agent) => agent.id !== dossier.id && agent.kind !== 'helper');
  async function save(event: FormEvent) {
    event.preventDefault();
    const monthlyUsd = monthly.trim() === '' ? null : Number(monthly);
    if (monthlyUsd !== null && (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0)) {
      setError('The monthly cap has to be greater than zero, or left blank.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post(`/api/organization/agents/${dossier.id}`, {
        name,
        kind,
        brief,
        monthlyUsd,
      });
      if (kind !== 'helper')
        await post(`/api/organization/agents/${dossier.id}/reports`, { reportsTo });
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="org-form" onSubmit={(event) => void save(event)}>
      <Field label="Name">
        <input
          className="input"
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Kind">
        <select
          className="input"
          value={kind}
          onChange={(event) => setKind(event.target.value as OrgKind)}
        >
          {orgKinds.map((value) => (
            <option key={value} value={value}>
              {kindLabels[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="What this agent is for"
        hint="Scope for Otto. It does not grant permission to write anywhere."
      >
        <textarea
          className="input"
          rows={4}
          maxLength={4000}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
        />
      </Field>
      <Field
        label="Monthly cap (USD)"
        hint="Blank means no cap. The Trust limit still pauses Otto as a whole."
      >
        <input
          className="input"
          inputMode="decimal"
          value={monthly}
          onChange={(event) => setMonthly(event.target.value)}
        />
      </Field>
      {kind === 'helper' ? (
        <p className="org-meta">A helper stays off the chart and reports to nobody.</p>
      ) : (
        <fieldset>
          <legend>Reports to</legend>
          {managers.length ? (
            <ul className="org-managers">
              {managers.map((agent) => (
                <li key={agent.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={reportsTo.includes(agent.id)}
                      onChange={(event) =>
                        setReportsTo((current) =>
                          event.target.checked
                            ? [...current, agent.id]
                            : current.filter((id) => id !== agent.id),
                        )
                      }
                    />
                    <span>
                      {agent.name} <small>{kindLabels[agent.kind]}</small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="org-meta">Add another agent before you can set a reporting line.</p>
          )}
        </fieldset>
      )}
      {error && <Notice>{error}</Notice>}
      <div className="org-actions">
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            void api(`/api/organization/agents/${dossier.id}`, { method: 'DELETE' })
              .then(onSaved)
              .catch((cause) => setError(errorMessage(cause)));
          }}
        >
          {confirmDelete ? 'Delete this agent' : 'Delete'}
        </Button>
      </div>
    </form>
  );
}

function EntryForm({ agentId, onSaved }: { agentId: string; onSaved(): Promise<unknown> }) {
  const [kind, setKind] = useState<OrgEntryKind>('note');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post(`/api/organization/agents/${agentId}/entries`, {
        kind,
        title,
        body,
        link: link.trim() || null,
      });
      setTitle('');
      setBody('');
      setLink('');
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="saved-plan org-entry-form" onSubmit={(event) => void submit(event)}>
      <h2>Add to the dossier</h2>
      <Field label="Kind">
        <select
          className="input"
          value={kind}
          onChange={(event) => setKind(event.target.value as OrgEntryKind)}
        >
          {orgEntryKinds.map((value) => (
            <option key={value} value={value}>
              {entryLabels[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Title">
        <input
          className="input"
          value={title}
          maxLength={160}
          required
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field label="Link" hint="Optional. Put the source first when this is evidence.">
        <input
          className="input"
          value={link}
          maxLength={2000}
          onChange={(event) => setLink(event.target.value)}
        />
      </Field>
      <Field label="What to keep">
        <textarea
          className="input"
          rows={4}
          maxLength={8000}
          required
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </Field>
      {error && <Notice>{error}</Notice>}
      <Button type="submit" disabled={busy || !title.trim() || !body.trim()}>
        {busy ? 'Saving…' : 'Save entry'}
      </Button>
    </form>
  );
}
