const parse = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { text: value };
  }
};

const lookup = (value, path) =>
  path.reduce((current, key) => (current == null ? undefined : current[key]), value);

const pathOf = (text) =>
  [...text.matchAll(/\.([A-Za-z_$][\w$]*)|\[\s*(['"])(.*?)\2\s*\]/g)].map(
    (match) => match[1] ?? match[3],
  );

function references(parameters) {
  const found = [];
  const visit = (value) => {
    if (typeof value === 'string') {
      if (!value.startsWith('=')) return;
      for (const match of value.matchAll(
        /\$json((?:\.[A-Za-z_$][\w$]*|\[\s*['"][^'"]+['"]\s*\])+)/g,
      ))
        found.push({ node: null, path: pathOf(match[1]), raw: match[0] });
      for (const match of value.matchAll(
        /(?:\$\(\s*(['"])(.+?)\1\s*\)\.(?:item|first\(\)|last\(\)|itemMatching\([^)]*\))|\$node\[\s*(['"])(.+?)\3\s*\])\.json((?:\.[A-Za-z_$][\w$]*|\[\s*['"][^'"]+['"]\s*\])+)/g,
      ))
        found.push({ node: match[2] ?? match[4], path: pathOf(match[5]), raw: match[0] });
    } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(parameters);
  return found;
}

const output = (runData, node, index = 0, run = 0) =>
  runData[node]?.[run]?.data?.main?.[index] ?? [];

function received(runData, node) {
  return (runData[node] ?? []).flatMap((task) =>
    (task.source ?? []).flatMap((source) =>
      source
        ? output(
            runData,
            source.previousNode,
            source.previousNodeOutput ?? 0,
            source.previousNodeRun ?? 0,
          )
        : [],
    ),
  );
}

const blank = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

const preview = (items, size = 300) => {
  const text = JSON.stringify(items.slice(0, 2).map((item) => item.json));
  return `${items.length} item${items.length === 1 ? '' : 's'}: ${text.length > size ? `${text.slice(0, size)}…` : text}`;
};

function mainNodes(workflow) {
  const fed = new Set();
  const feeds = new Set();
  for (const [from, outputs] of Object.entries(workflow.connections ?? {}))
    for (const target of outputs.main ?? [])
      for (const link of target ?? []) {
        feeds.add(from);
        fed.add(link.node);
      }
  return workflow.nodes.filter(
    (node) =>
      !node.disabled &&
      !node.type.endsWith('.stickyNote') &&
      (fed.has(node.name) || feeds.has(node.name)),
  );
}

function report(workflow, data, pinned) {
  const runData = data?.resultData?.runData ?? {};
  const error = data?.resultData?.error;
  const nodes = mainNodes(workflow);
  const notRun = nodes.filter((node) => !runData[node.name]).map((node) => node.name);
  const empty = [];
  for (const name of pinned) {
    const node = workflow.nodes.find((candidate) => candidate.name === name);
    if (!node || !runData[name]) continue;
    const input = received(runData, name);
    for (const reference of references(node.parameters)) {
      const items = reference.node ? output(runData, reference.node) : input;
      if (!items.length) {
        empty.push(
          `${name}: ${reference.raw} has no ${reference.node ? `output from ${reference.node}` : 'input items'}`,
        );
        continue;
      }
      const missing = items.filter((item) => blank(lookup(item.json, reference.path))).length;
      if (missing)
        empty.push(`${name}: ${reference.raw} is empty in ${missing} of ${items.length} items`);
    }
  }
  const failed = Object.entries(runData).flatMap(([name, tasks]) =>
    tasks
      .filter((task) => task.error)
      .map((task) => `${name}: ${task.error.message ?? JSON.stringify(task.error)}`),
  );
  return {
    error: error
      ? `${error.node?.name ?? data.resultData.lastNodeExecuted ?? 'workflow'}: ${error.message}`
      : undefined,
    failed,
    notRun,
    empty,
    outputs: Object.fromEntries(
      nodes
        .filter((node) => runData[node.name])
        .map((node) => [node.name, preview(output(runData, node.name))]),
    ),
  };
}

async function run(workflowId, workflow, scenario, outputs) {
  const started = parse(
    await tools.mcp__n8n__test_workflow({
      workflowId,
      pinData: scenario.pinData,
      ...(scenario.triggerNodeName ? { triggerNodeName: scenario.triggerNodeName } : {}),
    }),
  );
  if (!started.executionId)
    return {
      stop: Boolean(started.text),
      status: started.status,
      error: started.error ?? started.text,
    };
  const { execution, data } = parse(
    await tools.mcp__n8n__get_workflow_execution({
      workflowId,
      executionId: started.executionId,
      includeData: true,
    }),
  );
  const pinned = Object.keys(scenario.pinData ?? {});
  const found = report(workflow, data, pinned);
  const expected = scenario.expect ?? {};
  const runData = data?.resultData?.runData ?? {};
  const checks = Object.entries(expected.items ?? {}).flatMap(([name, rule]) => {
    const items = pinned.includes(name) ? received(runData, name) : output(runData, name);
    const misses = [];
    if (rule.count !== undefined && items.length !== rule.count)
      misses.push(`${name}: ${items.length} items, expected ${rule.count}`);
    for (const [path, value] of Object.entries(rule.fields ?? {}))
      items.forEach((item, index) => {
        const actual = lookup(item.json, path.split('.'));
        const ok =
          typeof value === 'string' && typeof actual === 'string'
            ? actual.includes(value)
            : JSON.stringify(actual) === JSON.stringify(value);
        if (!ok)
          misses.push(
            `${name} item ${index + 1}: ${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`,
          );
      });
    return misses;
  });
  const problems = [
    ...(expected.reached ?? [])
      .filter((name) => found.notRun.includes(name))
      .map((name) => `expected ${name} to run`),
    ...(expected.notReached ?? [])
      .filter((name) => !found.notRun.includes(name))
      .map((name) => `expected ${name} not to run`),
    ...checks,
  ];
  return {
    executionId: started.executionId,
    status: execution?.status ?? started.status,
    ...(found.error ? { error: found.error } : {}),
    ...(found.failed.length ? { failed: found.failed } : {}),
    ...(problems.length ? { problems } : {}),
    ...(found.empty.length ? { empty: found.empty } : {}),
    notRun: found.notRun,
    outputs: outputs.length
      ? Object.fromEntries(Object.entries(found.outputs).filter(([name]) => outputs.includes(name)))
      : found.outputs,
  };
}

function starts(workflow) {
  const fed = new Set(
    Object.values(workflow.connections ?? {}).flatMap((outputs) =>
      Object.values(outputs).flatMap((targets) =>
        (targets ?? []).flatMap((links) => (links ?? []).map((link) => link.node)),
      ),
    ),
  );
  const feeds = new Set(
    Object.entries(workflow.connections ?? {})
      .filter(([, outputs]) => (outputs.main ?? []).some((links) => links?.length))
      .map(([name]) => name),
  );
  return workflow.nodes
    .filter((node) => !node.disabled && feeds.has(node.name) && !fed.has(node.name))
    .map((node) => node.name);
}

async function check(workflowId, workflow) {
  const issues = new Set();
  for (const start of starts(workflow)) {
    const result = parse(
      await tools.mcp__n8n__test_workflow({
        workflowId,
        pinData: { [start]: [] },
        triggerNodeName: start,
      }),
    );
    if (result.text) return { stop: true, issues: [result.text] };
    const error = String(result.error ?? '');
    if (!error) continue;
    if (!/(?:node has|nodes have) issues:/.test(error)) {
      issues.add(error);
      continue;
    }
    const single = /^The '(.+)' node has issues:/.exec(error)?.[1];
    for (const line of error.split('\n').slice(1)) {
      const item = line.replace(/^\s*-\s*/, '').trim();
      if (item) issues.add(single ? `'${single}': ${item}` : item);
    }
  }
  return { issues: [...issues] };
}

async function verify({ workflowId, scenarios, outputs = [] }) {
  const { workflow } = parse(await tools.mcp__n8n__get_workflow_details({ workflowId }));
  const config = await check(workflowId, workflow);
  if (config.stop) return { config: config.issues, scenarios: [] };
  const results = [];
  for (const scenario of scenarios) {
    const result = await run(workflowId, workflow, scenario, outputs).catch((error) => ({
      error: String(error?.message ?? error),
    }));
    const { stop, ...rest } = result;
    results.push({ scenario: scenario.name, ...rest });
    if (stop) break;
  }
  return { config: config.issues, scenarios: results };
}

return { verify, check, report, references };
