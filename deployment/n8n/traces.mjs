export const tracesWorkflow = {
  name: 'Nod Traces',
  projectId: 'ja9rNGROYKEG8wUl',
  path: 'nod/traces',
  langsmithUrl: 'https://eu.api.smith.langchain.com/runs',
  langsmithWorkspaceId: 'df8b0b69-354e-412c-bfbd-8f8f9e06fdb0',
  langsmithProjectId: 'e809fc78-6fbd-4140-a0f4-b1e5b9515586',
  credentialName: 'nod LangSmith traces',
  webhookCredentialName: 'nod traces webhook',
  tokenHeader: 'x-nod-traces-token',
  perMinute: 600,
};

export const settings = {
  executionOrder: 'v1',
  saveExecutionProgress: false,
  saveManualExecutions: false,
  saveDataErrorExecution: 'none',
  saveDataSuccessExecution: 'none',
  executionTimeout: 60,
};

export function admitTrace(state, now, limit) {
  const minute = Math.floor(now / 60_000);
  if (state.minute !== minute) {
    state.minute = minute;
    state.count = 0;
  }
  state.count = (state.count ?? 0) + 1;
  return state.count <= limit;
}

export function checkTrace(input, project) {
  const data = input?.body ?? input;
  const run = data?.run;
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const time = (value) =>
    text(value, 40) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
  const usage = run?.usage;
  const details = usage?.input_token_details;
  const metadata = run?.metadata;
  const bytes = (value) => {
    let total = 0;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      total += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xdc00 ? 4 : 3;
      if (code >= 0xd800 && code < 0xdc00) index++;
    }
    return total;
  };
  const valid =
    record(data) &&
    data.version === 1 &&
    record(run) &&
    typeof run.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run.id) &&
    text(run.name, 200) &&
    text(run.provider, 100) &&
    time(run.start_time) &&
    time(run.end_time) &&
    Date.parse(run.end_time) >= Date.parse(run.start_time) &&
    record(run.inputs) &&
    Array.isArray(run.inputs.messages) &&
    Array.isArray(run.inputs.tools) &&
    run.inputs.tools.every((tool) => text(tool, 200)) &&
    record(run.outputs) &&
    (run.error === undefined || text(run.error, 20_000)) &&
    record(usage) &&
    count(usage.input_tokens) &&
    count(usage.output_tokens) &&
    count(usage.total_tokens) &&
    record(details) &&
    count(details.cache_read) &&
    count(details.cache_creation) &&
    (usage.total_cost === undefined || count(usage.total_cost)) &&
    record(metadata) &&
    Object.keys(metadata).length <= 20 &&
    Object.entries(metadata).every(
      ([key, value]) => /^[a-z_]{1,40}$/.test(key) && text(value, 200),
    ) &&
    bytes(JSON.stringify(data)) <= 8 * 1024 * 1024;
  if (!valid) return { ok: false };
  return {
    ok: true,
    run: {
      id: run.id,
      name: run.name,
      run_type: 'llm',
      start_time: run.start_time,
      end_time: run.end_time,
      inputs: { messages: run.inputs.messages, tools: run.inputs.tools },
      outputs: run.outputs,
      ...(run.error === undefined ? {} : { error: run.error }),
      session_id: project,
      extra: {
        metadata: {
          ...metadata,
          ls_provider: run.provider,
          ls_model_name: run.name,
          usage_metadata: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
            input_token_details: {
              cache_read: details.cache_read,
              cache_creation: details.cache_creation,
            },
            ...(usage.total_cost === undefined ? {} : { total_cost: usage.total_cost }),
          },
        },
      },
    },
  };
}

export function tracesWorkflowNodes(credentials = {}) {
  return [
    {
      id: 'a8e0d6c2-5b1f-4f0e-9c3a-7d2b1e4f6a01',
      name: 'Receive trace',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.2,
      position: [0, 0],
      webhookId: 'nod-traces',
      ...(credentials.webhook ? { credentials: { httpHeaderAuth: credentials.webhook } } : {}),
      parameters: {
        httpMethod: 'POST',
        path: tracesWorkflow.path,
        authentication: 'headerAuth',
        responseMode: 'onReceived',
        responseCode: 202,
        options: { responseData: 'noData' },
      },
    },
    {
      id: 'a8e0d6c2-5b1f-4f0e-9c3a-7d2b1e4f6a02',
      name: 'Validate trace',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 0],
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `const admitted = (${admitTrace.toString()})($getWorkflowStaticData('global'), $now.toMillis(), ${tracesWorkflow.perMinute});\nreturn [{json: admitted ? (${checkTrace.toString()})($input.first().json,${JSON.stringify(tracesWorkflow.langsmithProjectId)}) : { ok: false }}];`,
      },
    },
    {
      id: 'a8e0d6c2-5b1f-4f0e-9c3a-7d2b1e4f6a03',
      name: 'Valid trace?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [480, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              leftValue: '={{ $json.ok }}',
              rightValue: true,
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    },
    {
      id: 'a8e0d6c2-5b1f-4f0e-9c3a-7d2b1e4f6a04',
      name: 'Send to LangSmith',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, -100],
      onError: 'continueRegularOutput',
      retryOnFail: false,
      ...(credentials.langsmith ? { credentials: { httpHeaderAuth: credentials.langsmith } } : {}),
      parameters: {
        method: 'POST',
        url: tracesWorkflow.langsmithUrl,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'x-tenant-id', value: tracesWorkflow.langsmithWorkspaceId }],
        },
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: '={{ $json.run }}',
        options: {
          timeout: 20000,
          redirect: { redirect: { followRedirects: false } },
          response: { response: { fullResponse: true, neverError: true } },
        },
      },
    },
  ];
}

export function tracesWorkflowDefinition(credentials) {
  return {
    name: tracesWorkflow.name,
    nodes: tracesWorkflowNodes(credentials),
    connections: {
      'Receive trace': { main: [[{ node: 'Validate trace', type: 'main', index: 0 }]] },
      'Validate trace': { main: [[{ node: 'Valid trace?', type: 'main', index: 0 }]] },
      'Valid trace?': { main: [[{ node: 'Send to LangSmith', type: 'main', index: 0 }], []] },
    },
    settings,
  };
}
