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
] = await Promise.all([
  load('clients/n8n-client.ts'),
  load('run/lane-users.ts'),
  load('credentials/seeder.ts'),
  load('utils/user-proxy/index.ts'),
  load('build-expectations/verifier.ts'),
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
const members = new Map();
const proxies = new Map();

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
  members.set(user.id, client);
  return {
    userId: user.id,
    email: user.email,
    projectId,
    mcpApiKey,
    credentials: created.map((item) => ({ id: item.id, name: item.name, type: item.type })),
  };
}

async function workflows({ userId }) {
  const client = members.get(userId);
  if (!client) throw new Error('Unknown member.');
  const listed = await client.listWorkflows();
  const full = [];
  for (const item of listed) {
    const workflow = await client.getWorkflow(item.id).catch(() => undefined);
    if (workflow) full.push(workflow);
  }
  return full;
}

function startProxy({ id, conversation, messageBudget }) {
  proxies.set(id, new UserProxyLlm({ conversation, messageBudget, logger }));
  return {};
}

async function decide({ id, assistantText }) {
  const proxy = proxies.get(id);
  if (!proxy) throw new Error('Unknown conversation.');
  const events = [];
  if (assistantText.trim()) events.push({ type: 'text-delta', data: { text: assistantText } });
  events.push({ type: 'run-finish', data: {} });
  proxy.ingestEvents([...(proxy.otto ?? []), ...events]);
  proxy.otto = [...(proxy.otto ?? []), ...events];
  return proxy.decideFollowUp();
}

async function judge({ expectations, transcript, workflowId }) {
  const workflowJson = workflowId
    ? await owner.getWorkflow(workflowId).catch(() => undefined)
    : undefined;
  return verifyBuildExpectations(expectations, {
    transcript,
    ...(workflowJson ? { workflowJson } : {}),
  });
}

async function remove({ userIds }) {
  for (const id of userIds) {
    members.delete(id);
    await owner.deleteUser(id).catch(() => {});
  }
  return {};
}

const routes = {
  '/provision': provision,
  '/workflows': workflows,
  '/proxy/start': startProxy,
  '/proxy/decide': decide,
  '/judge': judge,
  '/remove': remove,
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
