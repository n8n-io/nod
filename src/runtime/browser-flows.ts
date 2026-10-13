import { posix } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  BrowserAction,
  BrowserObservation,
  Computer,
  WorkspaceSession,
} from '../ports/computer.ts';

const slug = Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 80 });
const waitMs = Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 }));
const selector = Type.String({ minLength: 1, maxLength: 500 });
const text = Type.String({ minLength: 1, maxLength: 500 });
const flowAction = Type.Union([
  Type.Object(
    { action: Type.Literal('open'), url: Type.String({ minLength: 1, maxLength: 2048 }), waitMs },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal('snapshot'), waitMs }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('click'), selector, waitMs }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal('fill'), selector, text, waitMs },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal('type'), selector, text, waitMs },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal('select'), selector, text, waitMs },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal('check'), selector, waitMs }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal('uncheck'), selector, waitMs },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('press'),
      key: Type.String({ minLength: 1, maxLength: 50 }),
      waitMs,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('scroll'),
      direction: Type.Union([Type.Literal('up'), Type.Literal('down')]),
      selector: Type.Optional(selector),
      waitMs,
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal('reload'), waitMs }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('back'), waitMs }, { additionalProperties: false }),
]);
export const browserFlowSchema = Type.Object(
  {
    id: slug,
    title: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 1, maxLength: 500 }),
    origin: Type.String({ minLength: 1, maxLength: 2048 }),
    inputs: Type.Record(
      Type.String({ pattern: '^[a-z][a-z0-9_]*$', maxLength: 40 }),
      Type.String({ minLength: 1, maxLength: 100 }),
    ),
    steps: Type.Array(
      Type.Object(
        {
          action: flowAction,
          expectText: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          expectUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

export const browserFlowParameters = Type.Union([
  Type.Object({
    action: Type.Literal('list'),
    query: Type.Optional(Type.String({ maxLength: 200 })),
  }),
  Type.Object({ action: Type.Literal('get'), id: slug }),
  Type.Object({ action: Type.Literal('save'), flow: browserFlowSchema }),
  Type.Object({
    action: Type.Literal('run'),
    id: slug,
    inputs: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 500 }))),
  }),
]);

type Flow = Static<typeof browserFlowSchema>;
type Request = Static<typeof browserFlowParameters>;

const storageProgram = `import json,os,stat,sys,tempfile
root=sys.argv[1]
request=json.load(sys.stdin)
os.umask(0o077)
if request['action']=='save': os.makedirs(root,mode=0o700,exist_ok=True)
def read(name):
 path=os.path.join(root,name+'.json')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_size>32768: raise ValueError('size')
  with os.fdopen(os.dup(fd),'rb') as file: return json.load(file)
 finally: os.close(fd)
if request['action']=='list':
 names=sorted(e.name[:-5] for e in os.scandir(root) if e.name.endswith('.json') and e.is_file(follow_symlinks=False)) if os.path.isdir(root) else []
 result=[]
 for name in names:
  try: result.append([name,read(name)])
  except Exception: result.append([name,None])
elif request['action']=='get': result=read(request['id'])
else:
 data=json.dumps(request['flow'],ensure_ascii=False,separators=(',',':')).encode()
 if len(data)>32768: raise ValueError('size')
 fd,path=tempfile.mkstemp(prefix='.flow-',dir=root)
 try:
  with os.fdopen(fd,'wb') as file:
   file.write(data)
   file.flush()
   os.fsync(file.fileno())
  os.replace(path,os.path.join(root,request['flow']['id']+'.json'))
  result={'path':os.path.join(root,request['flow']['id']+'.json')}
 finally:
  if os.path.exists(path): os.unlink(path)
sys.stdout.write(json.dumps(result))`;

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function flowOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.href !== url.origin + '/')
    throw new Error('A flow needs one HTTPS origin, such as https://example.com/.');
  return url.origin;
}

function placeholders(value: string) {
  return [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]);
}

function validateFlow(value: unknown): Flow {
  if (!Value.Check(browserFlowSchema, value)) throw new Error('The browser flow file is invalid.');
  const flow = value as Flow;
  const origin = flowOrigin(flow.origin);
  const inputs = Object.keys(flow.inputs);
  if (inputs.length > 30) throw new Error('A flow can use at most 30 inputs.');
  if (flow.steps[0].action.action !== 'open')
    throw new Error('The first flow step must open its website.');
  const final = flow.steps[flow.steps.length - 1];
  if (final.action.action !== 'snapshot' || (!final.expectText && !final.expectUrl))
    throw new Error('The last flow step must check the result with a snapshot.');
  for (const step of flow.steps) {
    const action = step.action;
    if ('selector' in action && action.selector && /^@e\d+$/.test(action.selector))
      throw new Error('Use a stable selector in a saved flow, not a page reference.');
    for (const value of [
      action.action === 'open' ? action.url : '',
      'text' in action ? action.text : '',
      step.expectText ?? '',
      step.expectUrl ?? '',
    ]) {
      for (const name of placeholders(value))
        if (!inputs.includes(name)) throw new Error(`The flow input ${name} is not declared.`);
    }
    if (action.action === 'open') {
      const url = new URL(action.url.replace(/\{\{[a-z][a-z0-9_]*\}\}/g, 'value'));
      if (url.origin !== origin || url.username || url.password)
        throw new Error('Every open step must use the flow origin without URL credentials.');
    }
    if (step.expectUrl) {
      const url = new URL(step.expectUrl.replace(/\{\{[a-z][a-z0-9_]*\}\}/g, 'value'));
      if (url.username || url.password)
        throw new Error('An expected URL must not contain URL credentials.');
    }
  }
  return flow;
}

function replaceInputs(value: string, inputs: Record<string, string>, encode: boolean) {
  return value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_match, name: string) =>
    encode ? encodeURIComponent(inputs[name]) : inputs[name],
  );
}

function summary(flow: Flow, path: string) {
  return {
    id: flow.id,
    title: flow.title,
    description: flow.description,
    origin: flow.origin,
    inputs: flow.inputs,
    steps: flow.steps.length,
    path,
  };
}

export function createBrowserFlows(
  workspace: WorkspaceSession,
  computer: Computer,
  browserId: string,
  signal: AbortSignal,
) {
  const root = posix.join(posix.dirname(workspace.path), '.otto', 'browser-flows');
  async function storage(request: Record<string, unknown>) {
    const chunks: Buffer[] = [];
    const { exitCode } = await workspace.exec(
      `python3 -c ${quote(storageProgram)} ${quote(root)}`,
      {
        input: JSON.stringify(request),
        signal,
        timeoutMs: 30000,
        onData: (chunk) => chunks.push(chunk),
      },
    );
    signal.throwIfAborted();
    if (exitCode)
      throw new Error('The browser flow library is unavailable or the flow file is invalid.');
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  return async (request: Request) => {
    if (request.action === 'save') {
      const flow = validateFlow(request.flow);
      const result = await storage({ action: 'save', flow });
      return { ...summary(flow, (result as { path: string }).path), status: 'saved' };
    }
    if (request.action === 'list') {
      const rows = (await storage({ action: 'list' })) as Array<[string, unknown]>;
      const invalid: string[] = [];
      const flows = rows.flatMap(([id, value]) => {
        try {
          const flow = validateFlow(value);
          if (flow.id !== id) throw new Error('The flow ID does not match its file.');
          return [summary(flow, `${root}/${id}.json`)];
        } catch {
          invalid.push(id);
          return [];
        }
      });
      const query = request.query?.toLowerCase().trim();
      const ranked = query
        ? flows
            .map((flow) => ({
              flow,
              score: query
                .split(/\s+/)
                .filter((term) =>
                  `${flow.id} ${flow.title} ${flow.description} ${flow.origin}`
                    .toLowerCase()
                    .includes(term),
                ).length,
            }))
            .sort((a, b) => b.score - a.score)
            .map(({ flow }) => flow)
        : flows;
      return { flows: ranked, invalid };
    }
    const flow = validateFlow(await storage({ action: 'get', id: request.id }));
    if (flow.id !== request.id) throw new Error('The flow ID does not match its file.');
    if (request.action === 'get') return { ...flow, path: `${root}/${flow.id}.json` };
    const inputs = request.inputs ?? {};
    if (
      Object.keys(inputs).some((key) => !Object.hasOwn(flow.inputs, key)) ||
      Object.keys(flow.inputs).some((key) => !Object.hasOwn(inputs, key))
    )
      throw new Error(`Give these flow inputs: ${Object.keys(flow.inputs).join(', ') || 'none'}.`);
    let observation: BrowserObservation | undefined;
    for (let index = 0; index < flow.steps.length; index++) {
      signal.throwIfAborted();
      const step = flow.steps[index];
      const action = { ...step.action } as BrowserAction;
      if (action.url) action.url = replaceInputs(action.url, inputs, true);
      if (action.text) action.text = replaceInputs(action.text, inputs, false);
      if (action.url && new URL(action.url).origin !== flowOrigin(flow.origin))
        return {
          status: 'needs_repair',
          step: index + 1,
          reason: 'An input changed the saved origin.',
          observation,
        };
      try {
        observation = await computer.act(browserId, action, signal);
      } catch {
        signal.throwIfAborted();
        const current = await computer
          .act(browserId, { action: 'snapshot' }, signal)
          .catch(() => observation);
        return {
          status: 'needs_repair',
          step: index + 1,
          reason: 'The browser step failed. Inspect the page and update the flow.',
          observation: current,
        };
      }
      const expectedText = step.expectText && replaceInputs(step.expectText, inputs, false);
      const expectedUrl = step.expectUrl && replaceInputs(step.expectUrl, inputs, true);
      if (
        (expectedText && !observation.text.includes(expectedText)) ||
        (expectedUrl &&
          (!observation.url.startsWith(expectedUrl) ||
            URL.parse(observation.url)?.origin !== new URL(expectedUrl).origin))
      )
        return {
          status: 'needs_repair',
          step: index + 1,
          reason: 'The page did not match the saved result.',
          observation,
        };
    }
    return { status: 'completed', steps: flow.steps.length, observation };
  };
}
