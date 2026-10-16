import { randomUUID } from 'node:crypto';
import { iso, list, num, obj, str, type Args, type Tool } from './app-kit.ts';

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
const ignored = new Set([
  'the',
  'and',
  'for',
  'with',
  'not',
  'are',
  'was',
  'from',
  'this',
  'that',
  'when',
  'into',
  'any',
  'our',
]);

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
  const notFound = (what: string, hint: string) => new Error(`Entity not found: ${what}. ${hint}`);
  const team = (key: unknown) => {
    const found = teams.find((item) => item.id === key);
    if (!found) throw notFound('Team', 'Use a team id from LINEAR_LIST_LINEAR_TEAMS.');
    return found;
  };
  const user = (key: unknown) => {
    const found = users.find((item) => item.id === key);
    if (!found) throw notFound('User', 'Use a user id from LINEAR_LIST_LINEAR_USERS.');
    return found;
  };
  const issues = (seed.issues ?? []).map((issue) => {
    const prefix = issue.identifier.split('-')[0];
    const owningTeam = teams.find((item) => item.key === prefix);
    if (!owningTeam) throw new Error(`Seed issue ${issue.identifier} has no team ${prefix}.`);
    return {
      ...issue,
      id: issue.id ?? randomUUID(),
      team: owningTeam.key,
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
  const issue = (key: unknown) => {
    const text = String(key ?? '');
    const found = issues.find(
      (item) => item.id === text || item.identifier.toLowerCase() === text.toLowerCase(),
    );
    if (!found || found.archived)
      throw notFound('Issue', 'Use an issue id or identifier such as ENG-12.');
    return found;
  };
  const stateOf = (item: Stored) =>
    teams
      .find((entry) => entry.key === item.team)!
      .states.find((state) => state.name === item.state)!;
  const userView = (email?: string) => {
    const found = users.find((entry) => entry.email === email);
    return found ? { id: found.id, name: found.name, email: found.email } : null;
  };
  const view = (item: Stored, full = false) => {
    const owningTeam = teams.find((entry) => entry.key === item.team)!;
    const project = projects.find((entry) => entry.name === item.project);
    return {
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      description: item.description,
      priority: item.priority,
      priorityLabel: priorities[item.priority] ?? 'No priority',
      state: { id: stateOf(item).id, name: item.state, type: stateOf(item).type },
      assignee: userView(item.assignee),
      team: { id: owningTeam.id, key: owningTeam.key, name: owningTeam.name },
      project: project ? { id: project.id, name: project.name } : null,
      labels: {
        nodes: item.labels.map((name) => ({
          id: labels.find((entry) => entry.name === name)?.id,
          name,
        })),
      },
      dueDate: item.dueDate ?? null,
      createdAt: iso(item.created),
      updatedAt: iso(item.updated),
      completedAt: item.completed ? iso(item.completed) : null,
      url: `https://linear.app/acme/issue/${item.identifier}`,
      ...(full
        ? {
            comments: {
              nodes: item.comments.map((comment) => ({
                body: comment.body,
                user: userView(comment.user) ?? { name: comment.user },
                createdAt: iso(comment.at),
              })),
            },
          }
        : {}),
    };
  };
  const page = (found: Stored[], args: Args, ranked = false) => {
    const first = Math.min(Number(args.first ?? args.limit ?? 50), 250);
    const offset = Number(args.after ?? 0) || 0;
    const slice = (ranked ? found : found.sort((a, b) => b.updated - a.updated))
      .slice(offset, offset + first)
      .map((item) => view(item));
    return {
      issues: slice,
      page_info: {
        hasNextPage: offset + first < found.length,
        endCursor: offset + first < found.length ? String(offset + first) : null,
      },
    };
  };
  const apply = (item: Stored, args: Args) => {
    const pick = (...keys: string[]) =>
      keys.map((key) => args[key]).find((value) => value !== undefined);
    const title = pick('title');
    const description = pick('description');
    const stateId = pick('stateId', 'state_id');
    const assigneeId = pick('assigneeId', 'assignee_id');
    const priority = pick('priority');
    const labelIds = pick('labelIds', 'label_ids');
    const dueDate = pick('dueDate', 'due_date');
    const projectId = pick('projectId', 'project_id');
    const owningTeam = teams.find((entry) => entry.key === item.team)!;
    const next = { ...item };
    if (title !== undefined) next.title = String(title);
    if (description !== undefined) next.description = String(description);
    if (stateId !== undefined) {
      const state = owningTeam.states.find((entry) => entry.id === stateId);
      if (!state)
        throw notFound(
          'WorkflowState',
          "Use a state id of the issue's team from LINEAR_LIST_LINEAR_STATES.",
        );
      next.state = state.name;
      next.completed = state.type === 'completed' ? now() : undefined;
    }
    if (assigneeId !== undefined) next.assignee = assigneeId ? user(assigneeId).email : undefined;
    if (priority !== undefined) {
      const value = Number(priority);
      if (!Number.isInteger(value) || value < 0 || value > 4)
        throw new Error('priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low).');
      next.priority = value;
    }
    if (labelIds !== undefined)
      next.labels = [labelIds].flat().map((labelId) => {
        const label = labels.find((entry) => entry.id === labelId);
        if (!label) throw notFound('IssueLabel', 'Use a label id from LINEAR_LIST_LINEAR_LABELS.');
        return label.name;
      });
    if (dueDate !== undefined) next.dueDate = dueDate ? String(dueDate).slice(0, 10) : undefined;
    if (projectId !== undefined) {
      const project = projects.find((entry) => entry.id === projectId);
      if (projectId && !project)
        throw notFound('Project', 'Use a project id from LINEAR_LIST_LINEAR_PROJECTS.');
      next.project = project?.name;
    }
    next.updated = now();
    Object.assign(item, next);
  };
  const tools: Tool[] = [
    {
      slug: 'LINEAR_GET_CURRENT_USER',
      description: 'Return the profile of the connected Linear user.',
      inputSchema: obj({}),
      run: () => ({ id: users[0].id, name: owner.name, email: owner.email }),
    },
    {
      slug: 'LINEAR_LIST_LINEAR_TEAMS',
      description: 'List teams with their ids, keys, members and projects.',
      inputSchema: obj({}),
      run: () => ({
        teams: teams.map((entry) => ({
          id: entry.id,
          key: entry.key,
          name: entry.name,
          members: users.map((member) => ({ id: member.id, name: member.name })),
          projects: projects
            .filter((project) => project.team === entry.key)
            .map((project) => ({ id: project.id, name: project.name })),
        })),
      }),
    },
    {
      slug: 'LINEAR_LIST_LINEAR_USERS',
      description: 'List workspace users with their ids, names and emails.',
      inputSchema: obj({}),
      run: () => ({
        users: users.map((entry) => ({
          id: entry.id,
          name: entry.name,
          email: entry.email,
          active: true,
        })),
      }),
    },
    {
      slug: 'LINEAR_LIST_LINEAR_STATES',
      description: 'List the workflow states of a team.',
      inputSchema: obj({ team_id: str('Team id.') }, ['team_id']),
      run: (args) => ({
        states: team(args.team_id).states.map((state) => ({
          id: state.id,
          name: state.name,
          type: state.type,
        })),
      }),
    },
    {
      slug: 'LINEAR_LIST_LINEAR_LABELS',
      description: 'List issue labels.',
      inputSchema: obj({ team_id: str('Team id, optional.') }),
      run: () => ({ labels: labels.map((label) => ({ id: label.id, name: label.name })) }),
    },
    {
      slug: 'LINEAR_LIST_LINEAR_PROJECTS',
      description: 'List projects.',
      inputSchema: obj({}),
      run: () => ({
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          teams: [{ key: project.team }],
        })),
      }),
    },
    {
      slug: 'LINEAR_LIST_LINEAR_ISSUES',
      description:
        'List non-archived issues, newest update first, optionally filtered by project_id or assignee_id. Paginate with first and after.',
      inputSchema: obj({
        project_id: str('Project id.'),
        assignee_id: str('User id.'),
        first: num('Page size, up to 250.'),
        after: str('Cursor from page_info.endCursor.'),
      }),
      run(args) {
        const project = args.project_id
          ? projects.find((entry) => entry.id === args.project_id)
          : undefined;
        if (args.project_id && !project)
          throw notFound('Project', 'Use a project id from LINEAR_LIST_LINEAR_PROJECTS.');
        const assignee = args.assignee_id ? user(args.assignee_id) : undefined;
        return page(
          issues.filter(
            (item) =>
              !item.archived &&
              (!project || item.project === project.name) &&
              (!assignee || item.assignee === assignee.email),
          ),
          args,
        );
      },
    },
    {
      slug: 'LINEAR_LIST_ISSUES_BY_TEAM_ID',
      description: 'List the non-archived issues of one team.',
      inputSchema: obj(
        { team_id: str('Team id.'), first: num('Page size.'), after: str('Cursor.') },
        ['team_id'],
      ),
      run(args) {
        const owningTeam = team(args.team_id);
        return page(
          issues.filter((item) => !item.archived && item.team === owningTeam.key),
          args,
        );
      },
    },
    {
      slug: 'LINEAR_SEARCH_ISSUES',
      description: 'Full-text search across issue identifiers, titles and descriptions.',
      inputSchema: obj({ query: str('Search text.'), first: num('Maximum results.') }, ['query']),
      run(args) {
        const terms = String(args.query)
          .toLowerCase()
          .split(/[^\p{L}\p{N}-]+/u)
          .filter((term) => term.length > 2 && !ignored.has(term));
        const scored = issues
          .filter((item) => !item.archived)
          .map((item) => {
            const text = `${item.identifier} ${item.title} ${item.description}`.toLowerCase();
            return { item, score: terms.filter((term) => text.includes(term)).length };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || b.item.updated - a.item.updated);
        return page(
          scored.map((entry) => entry.item),
          args,
          true,
        );
      },
    },
    {
      slug: 'LINEAR_GET_LINEAR_ISSUE',
      description: 'Get one issue with its comments, by id or identifier such as ENG-12.',
      inputSchema: obj({ issue_id: str('Issue id or identifier.') }, ['issue_id']),
      run: (args) => view(issue(args.issue_id ?? args.issueId), true),
    },
    {
      slug: 'LINEAR_CREATE_LINEAR_ISSUE',
      description:
        'Create an issue in a team. priority is 0 none, 1 urgent, 2 high, 3 medium, 4 low. due_date is YYYY-MM-DD.',
      inputSchema: obj(
        {
          team_id: str('Team id.'),
          title: str('Title.'),
          description: str('Markdown description.'),
          priority: num('0 to 4.'),
          assignee_id: str('User id.'),
          state_id: str('Workflow state id.'),
          label_ids: list({ type: 'string' }, 'Label ids.'),
          project_id: str('Project id.'),
          due_date: str('YYYY-MM-DD.'),
        },
        ['team_id', 'title'],
      ),
      write: 'create',
      run(args) {
        const owningTeam = team(args.team_id);
        const number =
          Math.max(
            0,
            ...issues
              .filter((item) => item.team === owningTeam.key)
              .map((item) => Number(item.identifier.split('-')[1]) || 0),
          ) + 1;
        const created: Stored = {
          id: randomUUID(),
          identifier: `${owningTeam.key}-${number}`,
          title: '',
          description: '',
          state: 'Todo',
          team: owningTeam.key,
          priority: 0,
          labels: [],
          created: now(),
          updated: now(),
          comments: [],
          archived: false,
        };
        apply(created, args);
        if (!created.title.trim()) throw new Error('title must not be empty.');
        issues.push(created);
        return view(created);
      },
    },
    {
      slug: 'LINEAR_UPDATE_ISSUE',
      description:
        'Update an issue by id or identifier. Provided fields overwrite: title, description, stateId, assigneeId, priority, labelIds, dueDate, projectId.',
      inputSchema: obj(
        {
          issueId: str('Issue id or identifier.'),
          title: str('Title.'),
          description: str('Description.'),
          stateId: str('Workflow state id.'),
          assigneeId: str('User id.'),
          priority: num('0 to 4.'),
          labelIds: list({ type: 'string' }, 'Label ids, replacing the current ones.'),
          dueDate: str('YYYY-MM-DD.'),
          projectId: str('Project id.'),
        },
        ['issueId'],
      ),
      write: 'update',
      run(args) {
        const item = issue(args.issueId ?? args.issue_id);
        apply(item, args);
        return view(item);
      },
    },
    {
      slug: 'LINEAR_CREATE_LINEAR_COMMENT',
      description: 'Post a comment on an issue.',
      inputSchema: obj({ issueId: str('Issue id or identifier.'), body: str('Markdown body.') }, [
        'issueId',
        'body',
      ]),
      write: 'post',
      run(args) {
        const item = issue(args.issueId ?? args.issue_id);
        const body = String(args.body ?? '').trim();
        if (!body) throw new Error('body must not be empty.');
        item.comments.push({ user: owner.email, body, at: now() });
        item.updated = now();
        return { id: randomUUID(), body, issue: { id: item.id, identifier: item.identifier } };
      },
    },
    {
      slug: 'LINEAR_ARCHIVE_ISSUE',
      description: 'Archive an issue, hiding it from active views.',
      inputSchema: obj({ issue_id: str('Issue id or identifier.') }, ['issue_id']),
      write: 'delete',
      run(args) {
        const item = issue(args.issue_id ?? args.issueId);
        item.archived = true;
        item.updated = now();
        return { success: true, identifier: item.identifier };
      },
    },
  ];
  return { tools, issues, teams, users, labels, projects };
}
