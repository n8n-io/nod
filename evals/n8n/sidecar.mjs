import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.N8N_EVAL_SOURCE;
const base = process.env.N8N_BASE_URL;
if (!root || !base) throw new Error('Set N8N_EVAL_SOURCE and N8N_BASE_URL.');
const load = (path) => import(pathToFileURL(join(root, 'evaluations', path)).href);
const [
  { N8nClient },
  { LaneUserPool },
  { createDeclaredCredentials },
  { UserProxyLlm },
  { verifyBuildExpectations },
  { resolveArtifactContext },
  { CaseSeedSchema },
  { remapSeedArtifactIds, transcriptPrefixFromSeed },
  { uniquifySeedTableNames },
  { executePriorRuns },
  { attachedWorkflowNote, attachedAgentNote },
] = await Promise.all([
  load('clients/n8n-client.ts'),
  load('run/lane-users.ts'),
  load('credentials/seeder.ts'),
  load('utils/user-proxy/index.ts'),
  load('build-expectations/verifier.ts'),
  load('harness/artifacts/artifact-context.ts'),
  load('harness/schema.ts'),
  load('harness/conversation-seed.ts'),
  load('harness/seed-tables.ts'),
  load('harness/prior-runs.ts'),
  load('utils/conversation-text.ts'),
]);

const logger = {
  isVerbose: false,
  info: () => {},
  verbose: () => {},
  success: () => {},
  warn: (message) => process.stderr.write(`[sidecar] ${message}\n`),
  error: (message) => process.stderr.write(`[sidecar] ${message}\n`),
};
const owner = new N8nClient(base);
await owner.login(process.env.N8N_EVAL_EMAIL, process.env.N8N_EVAL_PASSWORD);
await owner.enableMcpAccess();
const users = new LaneUserPool(owner);
const proxies = new Map();
const list = (result) => (Array.isArray(result) ? result : (result?.data ?? []));

async function provision({ credentials = [] }) {
  const user = await users.claim();
  const client = new N8nClient(base);
  await client.acceptInvitation({
    token: user.acceptToken,
    firstName: 'Eval',
    lastName: 'Builder',
    password: users.password,
  });
  const mcpApiKey = await client.rotateMcpApiKey();
  const created = await createDeclaredCredentials(client, credentials, { logger });
  const projectId = await client.getPersonalProjectId();
  return {
    userId: user.id,
    email: user.email,
    projectId,
    mcpApiKey,
    credentials: created.map((item) => ({ id: item.id, name: item.name, type: item.type })),
  };
}

async function personalProject(userId) {
  const project = list(await owner.fetch('/rest/projects')).find(
    (item) => item.type === 'personal' && item.creatorId === userId,
  );
  if (!project) throw new Error('The member has no personal project.');
  return project;
}

const textOf = (blocks = []) =>
  blocks
    .flatMap((block) =>
      block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('\n');

async function seedCase({ userId, seed, attach }) {
  const project = await personalProject(userId);
  const parsed = CaseSeedSchema.parse(seed);
  const remapped = remapSeedArtifactIds(parsed);
  const threadId = randomUUID();
  await owner.ensureThread(threadId, project.id);
  for (const item of remapped.projects ?? []) await owner.createTeamProject(item.name);
  const folders = remapped.folders ?? [];
  const restored =
    remapped.workflows.length ||
    remapped.dataTables.length ||
    remapped.agents.length ||
    folders.length
      ? await owner.restoreThread(
          threadId,
          [],
          remapped.workflows,
          uniquifySeedTableNames(remapped.dataTables),
          remapped.agents,
          { folders, uniquifyNames: false },
        )
      : { workflowIds: [], agentIds: [] };
  for (const kind of ['workflows', 'agents'])
    await owner
      .fetch(`/rest/mcp/${kind}/toggle-access`, {
        method: 'PATCH',
        body: { availableInMCP: true, projectId: project.id },
      })
      .catch((error) => logger.warn(`MCP access for seeded ${kind}: ${error.message}`));
  const workflows = new Map(
    parsed.workflows.map((workflow, index) => [
      workflow.id,
      {
        ...remapped.workflows[index],
        id: restored.workflowIds[index] ?? remapped.workflows[index].id,
      },
    ]),
  );
  const agents = new Map(
    parsed.agents.map((agent, index) => [
      agent.id,
      { id: restored.agentIds[index], name: remapped.agents[index].config.name },
    ]),
  );
  const failedRuns = parsed.priorRuns?.length
    ? (
        await executePriorRuns({
          client: owner,
          priorRuns: parsed.priorRuns,
          seedWorkflows: workflows,
          logger,
        })
      ).filter((outcome) => !outcome.ran)
    : [];
  if (failedRuns.length)
    throw new Error(
      `A prior run did not record an execution: ${failedRuns.map((run) => run.workflow).join(', ')}`,
    );
  const workflow = attach?.workflow ? workflows.get(attach.workflow) : undefined;
  const agent = attach?.agent ? agents.get(attach.agent) : undefined;
  if ((attach?.workflow && !workflow) || (attach?.agent && !agent))
    throw new Error('The attached seed artifact was not restored.');
  return {
    messages: remapped.messages
      .filter(
        (message) => message.type !== 'custom' && ['user', 'assistant'].includes(message.role),
      )
      .map((message) => ({ role: message.role, text: textOf(message.content) }))
      .filter((message) => message.text.trim()),
    transcript: transcriptPrefixFromSeed(remapped.messages),
    note: workflow
      ? attachedWorkflowNote(`${workflow.name}, id ${workflow.id}`)
      : agent
        ? attachedAgentNote(`${agent.name}, id ${agent.id}`)
        : '',
  };
}

async function artifacts({ userId }) {
  const project = await personalProject(userId);
  const filter = encodeURIComponent(JSON.stringify({ projectId: project.id }));
  const workflows = [];
  for (const item of list(await owner.fetch(`/rest/workflows?filter=${filter}`))) {
    const workflow = await owner.getWorkflow(item.id).catch(() => undefined);
    if (workflow) workflows.push(workflow);
  }
  const agents = list(
    await owner.fetch(`/rest/projects/${project.id}/agents/v2`).catch(() => []),
  ).map((agent) => ({ id: agent.id, name: agent.name }));
  return { projectId: project.id, workflows, agents };
}

function startProxy({ id, conversation, messageBudget }) {
  proxies.set(id, { proxy: new UserProxyLlm({ conversation, messageBudget, logger }), events: [] });
  return {};
}

async function decide({ id, assistantText }) {
  const entry = proxies.get(id);
  if (!entry) throw new Error('Unknown conversation.');
  if (assistantText.trim())
    entry.events.push({ type: 'text-delta', data: { text: assistantText } });
  entry.events.push({ type: 'run-finish', data: {} });
  entry.proxy.ingestEvents(entry.events);
  return entry.proxy.decideFollowUp();
}

async function judge({ expectations, transcript, workflowId, projectId, agents = [] }) {
  const workflowJson = workflowId
    ? await owner.getWorkflow(workflowId).catch(() => undefined)
    : undefined;
  const artifactContext = await resolveArtifactContext({
    artifactRefs: agents.map((agent) => ({ type: 'agent', id: agent.id, projectId })),
    client: owner,
    logger,
  });
  return verifyBuildExpectations(expectations, {
    transcript,
    ...(workflowJson ? { workflowJson } : {}),
    ...(artifactContext ? { artifactContext } : {}),
  });
}

const routes = {
  '/provision': provision,
  '/artifacts': artifacts,
  '/seed': seedCase,
  '/proxy/start': startProxy,
  '/proxy/decide': decide,
  '/judge': judge,
};

const server = createServer(async (request, response) => {
  const route = routes[request.url ?? ''];
  if (request.method !== 'POST' || !route) {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  try {
    const result = await route(body ? JSON.parse(body) : {});
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(result ?? {}));
  } catch (error) {
    response
      .writeHead(500, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});
server.listen(Number(process.env.SIDECAR_PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(`SIDECAR_READY ${server.address().port}\n`);
});
