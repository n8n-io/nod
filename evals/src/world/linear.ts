import { randomUUID } from 'node:crypto';
import { iso, list, num, obj, str } from './app-kit.ts';
import type { McpTool } from './mcp.ts';

export interface LinearIssue {
  id?: string;
  identifier: string;
  title: string;
  description?: string;
  state: string;
  assignee?: string;
  priority?: number;
  labels?: string[];
  project?: string;
  dueDate?: string;
  created?: number;
  updated?: number;
  completed?: number;
  comments?: Array<{ user: string; body: string; at: number }>;
  archived?: boolean;
}

export interface LinearSeed {
  teams: Array<{ key: string; name: string }>;
  users?: Array<{ name: string; email: string }>;
  labels?: string[];
  projects?: Array<{ name: string; team: string }>;
  issues?: LinearIssue[];
}

const workflow = [
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'In Review', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
];
const priorities = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

function after(value: unknown, now: number) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const duration =
    /^-?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(text);
  if (duration) {
    const [, y, m, w, d, h, min] = duration.map((part) => Number(part ?? 0));
    const span = (y * 365 + m * 30 + w * 7 + d) * 86_400_000 + h * 3_600_000 + min * 60_000;
    return text.startsWith('-') ? now - span : now + span;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error(`Invalid date or duration: ${text}`);
  return at;
}

export function linear(
  owner: { name: string; email: string },
  seed: LinearSeed,
  now: () => number,
) {
  const teams = seed.teams.map((team) => ({
    ...team,
    id: randomUUID(),
    states: workflow.map((state) => ({ ...state, id: randomUUID() })),
  }));
  const users = [owner, ...(seed.users ?? [])].map((user) => ({ ...user, id: randomUUID() }));
  const labels = (seed.labels ?? []).map((name) => ({ name, id: randomUUID() }));
  const projects = (seed.projects ?? []).map((project) => ({ ...project, id: randomUUID() }));
  const issues = (seed.issues ?? []).map((issue) => {
    const prefix = issue.identifier.split('-')[0];
    if (!teams.some((item) => item.key === prefix))
      throw new Error(`Seed issue ${issue.identifier} has no team ${prefix}.`);
    if (!workflow.some((state) => state.name === issue.state))
      throw new Error(`Seed issue ${issue.identifier} has an unknown state ${issue.state}.`);
    return {
      ...issue,
      id: issue.id ?? randomUUID(),
      team: prefix,
      description: issue.description ?? '',
      priority: issue.priority ?? 0,
      labels: issue.labels ?? [],
      created: issue.created ?? now() - 30 * 86_400_000,
      updated: issue.updated ?? issue.created ?? now() - 30 * 86_400_000,
      comments: issue.comments ?? [],
      archived: issue.archived ?? false,
    };
  });
  type Stored = (typeof issues)[number];
  const fold = (value: unknown) =>
    String(value ?? '')
      .trim()
      .toLowerCase();
  const team = (value: unknown) => {
    const found = teams.find((item) =>
      [item.id, item.key, item.name].some((key) => fold(key) === fold(value)),
    );
    if (!found) throw new Error(`Team not found: ${value}`);
    return found;
  };
  const teamOf = (item: Stored) => teams.find((entry) => entry.key === item.team)!;
  const state = (value: unknown, owning: (typeof teams)[number]) => {
    const found =
      owning.states.find(
        (item) => fold(item.id) === fold(value) || fold(item.name) === fold(value),
      ) ?? owning.states.find((item) => fold(item.type) === fold(value));
    if (!found) throw new Error(`State not found in team ${owning.name}: ${value}`);
    return found;
  };
  const user = (value: unknown) => {
    if (fold(value) === 'me') return users[0];
    const matches = users.filter(
      (item) =>
        fold(item.id) === fold(value) ||
        fold(item.email) === fold(value) ||
        fold(item.name) === fold(value),
    );
    const partial = matches.length
      ? matches
      : users.filter((item) => fold(item.name).split(/\s+/)[0] === fold(value));
    if (partial.length !== 1)
      throw new Error(
        partial.length
          ? `Several users match ${value}; use an email or ID.`
          : `User not found: ${value}`,
      );
    return partial[0];
  };
  const label = (value: unknown) => {
    const found = labels.find(
      (item) => fold(item.id) === fold(value) || fold(item.name) === fold(value),
    );
    if (!found) throw new Error(`Label not found: ${value}`);
    return found.name;
  };
  const project = (value: unknown) => {
    const found = projects.find(
      (item) => fold(item.id) === fold(value) || fold(item.name) === fold(value),
    );
    if (!found) throw new Error(`Project not found: ${value}`);
    return found;
  };
  const issue = (value: unknown, archived = false) => {
    const found = issues.find(
      (item) => fold(item.id) === fold(value) || fold(item.identifier) === fold(value),
    );
    if (!found || (found.archived && !archived)) throw new Error(`Issue not found: ${value}`);
    return found;
  };
  const stateOf = (item: Stored) => teamOf(item).states.find((entry) => entry.name === item.state)!;
  const person = (email?: string) => users.find((entry) => entry.email === email);
  const view = (item: Stored, full = false) => ({
    id: item.identifier,
    title: item.title,
    ...(full ? { description: item.description } : {}),
    priority: { value: item.priority, name: priorities[item.priority] ?? 'No priority' },
    url: `https://linear.app/acme/issue/${item.identifier.toLowerCase()}`,
    createdAt: iso(item.created),
    updatedAt: iso(item.updated),
    completedAt: item.completed ? iso(item.completed) : null,
    dueDate: item.dueDate ?? null,
    status: item.state,
    statusType: stateOf(item).type,
    labels: item.labels,
    assignee: person(item.assignee)?.name ?? null,
    assigneeId: person(item.assignee)?.id ?? null,
    team: teamOf(item).name,
    teamId: teamOf(item).id,
    project: item.project ?? null,
    projectId: projects.find((entry) => entry.name === item.project)?.id ?? null,
    archivedAt: item.archived ? iso(item.updated) : null,
  });
  const page = <T>(found: T[], args: Record<string, any>) => {
    const limit = Math.min(Number(args.limit ?? 50), 250);
    const offset = Number(args.cursor ?? 0) || 0;
    const items = found.slice(offset, offset + limit);
    const more = offset + limit < found.length;
    return { items, hasNextPage: more, ...(more ? { cursor: String(offset + limit) } : {}) };
  };
  const apply = (item: Stored, args: Record<string, any>) => {
    const next = { ...item, labels: [...item.labels] };
    let owning = teamOf(item);
    if (args.team !== undefined && args.id !== undefined) {
      owning = team(args.team);
      next.team = owning.key;
    }
    if (args.title !== undefined) next.title = String(args.title);
    if (args.description !== undefined) next.description = String(args.description);
    if (args.state !== undefined) {
      const found = state(args.state, owning);
      next.state = found.name;
      next.completed = found.type === 'completed' ? now() : undefined;
    }
    if (args.assignee !== undefined)
      next.assignee = args.assignee === null ? undefined : user(args.assignee).email;
    if (args.priority !== undefined) {
      const value = Number(args.priority);
      if (!Number.isInteger(value) || value < 0 || value > 4)
        throw new Error('priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low).');
      next.priority = value;
    }
    if (args.labels !== undefined) next.labels = [args.labels].flat().map(label);
    for (const name of [args.addLabels ?? []].flat().map(label))
      if (!next.labels.includes(name)) next.labels.push(name);
    const removing = new Set([args.removeLabels ?? []].flat().map(label));
    next.labels = next.labels.filter((name) => !removing.has(name));
    if (args.dueDate !== undefined)
      next.dueDate = args.dueDate === null ? undefined : String(args.dueDate).slice(0, 10);
    if (args.project !== undefined)
      next.project = args.project === null ? undefined : project(args.project).name;
    next.updated = now();
    Object.assign(item, next);
  };
  const tools: McpTool[] = [
    {
      name: 'list_issues',
      description:
        'List issues in the user\'s Linear workspace. For issues assigned to me, use "me" as the assignee. Use "null" for no assignee.',
      inputSchema: obj({
        query: str('Search issue title or description.'),
        team: str('Team name or ID'),
        state: str('State type, name, or ID'),
        assignee: str('User ID, name, email, or "me"'),
        label: str('Label name or ID'),
        project: str('Project name or ID'),
        priority: num('0=None, 1=Urgent, 2=High, 3=Medium, 4=Low'),
        updatedAt: str('Updated after: ISO-8601 date/duration (e.g., -P1D)'),
        createdAt: str('Created after: ISO-8601 date/duration (e.g., -P1D)'),
        includeArchived: { type: 'boolean', default: false },
        orderBy: { type: 'string', enum: ['createdAt', 'updatedAt'], default: 'updatedAt' },
        limit: num('Maximum number of results to return per page (default 50, max 250).'),
        cursor: str(
          'Omit for the first page. To continue, pass the previous cursor when hasNextPage is true',
        ),
      }),
      run(args) {
        const owning = args.team ? team(args.team) : undefined;
        const assignee =
          args.assignee === undefined
            ? undefined
            : fold(args.assignee) === 'null' || args.assignee === null
              ? null
              : user(args.assignee);
        const updated = after(args.updatedAt, now());
        const created = after(args.createdAt, now());
        const terms = fold(args.query).split(/\s+/).filter(Boolean);
        const text = (item: Stored) => fold(`${item.identifier} ${item.title} ${item.description}`);
        const every = issues.filter((item) => terms.every((term) => text(item).includes(term)));
        const pool =
          terms.length && !every.length
            ? issues
                .map((item) => ({
                  item,
                  score: terms.filter((term) => term.length > 2 && text(item).includes(term))
                    .length,
                }))
                .filter((entry) => entry.score > 0)
                .sort((a, b) => b.score - a.score)
                .map((entry) => entry.item)
            : every;
        const found = pool
          .filter((item) => args.includeArchived || !item.archived)
          .filter((item) => !owning || item.team === owning.key)
          .filter((item) => {
            if (!args.state) return true;
            const wanted = fold(args.state);
            const current = stateOf(item);
            return [current.id, current.name, current.type].some((key) => fold(key) === wanted);
          })
          .filter((item) =>
            assignee === undefined
              ? true
              : assignee === null
                ? !item.assignee
                : item.assignee === assignee.email,
          )
          .filter((item) => !args.label || item.labels.includes(label(args.label)))
          .filter((item) => !args.project || item.project === project(args.project).name)
          .filter((item) => args.priority === undefined || item.priority === Number(args.priority))
          .filter((item) => updated === undefined || item.updated >= updated)
          .filter((item) => created === undefined || item.created >= created)
          .sort((a, b) =>
            terms.length && !every.length
              ? 0
              : args.orderBy === 'createdAt'
                ? b.created - a.created
                : b.updated - a.updated,
          );
        const result = page(found, args);
        return {
          issues: result.items.map((item) => view(item)),
          hasNextPage: result.hasNextPage,
          ...(result.cursor ? { cursor: result.cursor } : {}),
        };
      },
    },
    {
      name: 'get_issue',
      description:
        'Retrieve detailed information about an issue by ID or identifier (e.g., LIN-123).',
      inputSchema: obj({ id: str('Issue ID or identifier (e.g., LIN-123)') }, ['id']),
      run: (args) => view(issue(args.id, true), true),
    },
    {
      name: 'save_issue',
      description:
        'Create or update a Linear issue. If `id` is provided, updates the existing issue; otherwise creates a new one. When creating, `team` and `title` are required. Use `assignee` (not `assigneeId`); it accepts a user ID, name, email, or "me".',
      inputSchema: obj({
        id: str(
          'Only for updating an existing issue. Pass the issue ID or identifier (e.g., LIN-123).',
        ),
        title: str('Issue title (required when creating)'),
        description: str('Content as Markdown.'),
        team: str('Team name or ID (required when creating)'),
        state: str('State type, name, or ID'),
        assignee: {
          type: ['string', 'null'],
          description: 'User ID, name, email, or "me". Null to remove',
        },
        priority: num('0=None, 1=Urgent, 2=High, 3=Medium, 4=Low'),
        labels: list({ type: 'string' }, 'Label names or IDs. Replaces the full label set.'),
        addLabels: list({ type: 'string' }, 'Label names or IDs to add.'),
        removeLabels: list({ type: 'string' }, 'Label names or IDs to remove.'),
        dueDate: {
          type: ['string', 'null'],
          description: 'Due date (ISO format). On update, pass null to remove the due date',
        },
        project: { type: ['string', 'null'], description: 'Project name or ID. Null to remove' },
      }),
      write: (args) => (args.id ? 'update' : 'create'),
      run(args) {
        if (args.id) {
          const item = issue(args.id);
          const before = structuredClone(item);
          try {
            apply(item, args);
          } catch (error) {
            Object.assign(item, before);
            throw error;
          }
          return view(item, true);
        }
        if (!args.team) throw new Error('team is required when creating an issue.');
        if (!String(args.title ?? '').trim())
          throw new Error('title is required when creating an issue.');
        const owning = team(args.team);
        const number =
          Math.max(
            0,
            ...issues
              .filter((item) => item.team === owning.key)
              .map((item) => Number(item.identifier.split('-')[1]) || 0),
          ) + 1;
        const created: Stored = {
          id: randomUUID(),
          identifier: `${owning.key}-${number}`,
          title: '',
          description: '',
          state: 'Todo',
          team: owning.key,
          priority: 0,
          labels: [],
          created: now(),
          updated: now(),
          comments: [],
          archived: false,
        };
        apply(created, args);
        issues.push(created);
        return view(created, true);
      },
    },
    {
      name: 'list_comments',
      description: 'List comments on a Linear issue.',
      inputSchema: obj({ issueId: str('Issue ID or identifier (e.g., LIN-123)') }, ['issueId']),
      run: (args) => ({
        comments: issue(args.issueId, true).comments.map((comment) => ({
          body: comment.body,
          author: person(comment.user)?.name ?? comment.user,
          createdAt: iso(comment.at),
        })),
      }),
    },
    {
      name: 'save_comment',
      description: 'Create a comment on a Linear issue. Pass `body` and `issueId`.',
      inputSchema: obj(
        {
          body: str('Content as Markdown.'),
          issueId: str('Issue ID or identifier (e.g., LIN-123)'),
        },
        ['body', 'issueId'],
      ),
      write: 'post',
      run(args) {
        const item = issue(args.issueId);
        const body = String(args.body ?? '').trim();
        if (!body) throw new Error('body must not be empty.');
        item.comments.push({ user: owner.email, body, at: now() });
        item.updated = now();
        return { id: randomUUID(), body, issue: item.identifier };
      },
    },
    {
      name: 'list_issue_statuses',
      description: 'List available issue statuses in a Linear team',
      inputSchema: obj({ team: str('Team name or ID') }, ['team']),
      run: (args) => team(args.team).states.map(({ id, name, type }) => ({ id, name, type })),
    },
    {
      name: 'list_teams',
      description: "List teams in the user's Linear workspace",
      inputSchema: obj({ query: str('Search query') }),
      run: (args) =>
        teams
          .filter(
            (item) => !args.query || fold(`${item.key} ${item.name}`).includes(fold(args.query)),
          )
          .map(({ id, key, name }) => ({ id, key, name })),
    },
    {
      name: 'list_users',
      description: 'List workspace users with their IDs, names and emails.',
      inputSchema: obj({ query: str('Match part of a name or email.') }),
      run: (args) =>
        users
          .filter(
            (item) => !args.query || fold(`${item.name} ${item.email}`).includes(fold(args.query)),
          )
          .map(({ id, name, email }) => ({ id, name, email, active: true })),
    },
    {
      name: 'list_projects',
      description: "List projects in the user's Linear workspace",
      inputSchema: obj({ query: str('Search project name'), team: str('Team name or ID') }),
      run: (args) =>
        projects
          .filter((item) => !args.query || fold(item.name).includes(fold(args.query)))
          .filter((item) => !args.team || item.team === team(args.team).key)
          .map(({ id, name, team: key }) => ({
            id,
            name,
            team: teams.find((entry) => entry.key === key)?.name,
          })),
    },
    {
      name: 'list_issue_labels',
      description: 'List available issue labels in a Linear workspace or team.',
      inputSchema: obj({ name: str('Filter by name'), team: str('Team name or ID') }),
      run: (args) =>
        labels
          .filter((item) => !args.name || fold(item.name).includes(fold(args.name)))
          .map(({ id, name }) => ({ id, name })),
    },
  ];
  return { tools, issues, teams, users, labels, projects };
}
