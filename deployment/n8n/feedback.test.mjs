import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  checkFeedback,
  feedbackReceipt,
  feedbackWorkflow,
  feedbackWorkflowNodes,
  formatFeedbackIssue,
  hashFeedback,
  prepareFeedbackUpload,
} from './feedback.mjs';

const submissionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const file = (content, mimeType = 'application/json', name = 'otto-report.json') => ({
  name,
  mimeType,
  data: Buffer.from(content).toString('base64'),
  sha256: hashFeedback(Buffer.from(content)),
});
const envelope = (changes = {}) => {
  const value = {
    schemaVersion: 1,
    submissionId,
    category: 'bug',
    feedback: 'The example button is unavailable.\nIt happened after opening the example view.',
    computerName: 'Example Mac',
    appVersion: '0.1.2',
    appRelease: '33d3997',
    platform: 'darwin-arm64',
    development: true,
    source: 'desktop',
    appModified: null,
    report: file('{"messages":[{"text":"Synthetic example"}]}'),
    attachments: [],
    ...changes,
  };
  return {
    ...value,
    payloadHash: hashFeedback(JSON.stringify({ ...value, report: value.report ?? null })),
  };
};
const response = (request, attached = [], changes = {}) => ({
  statusCode: 200,
  body: {
    data: {
      issues: {
        nodes: [
          {
            id: submissionId,
            url: 'https://linear.app/n8n/issue/LAB-1/example',
            description: request.description,
            team: { id: feedbackWorkflow.linearTeamId },
            project: { id: feedbackWorkflow.linearProjectId },
            attachments: { nodes: attached, pageInfo: { hasNextPage: false } },
            ...changes,
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
  },
});
const attachment = (request, index = 0) => ({
  id: 'example',
  url: 'https://uploads.linear.app/example/asset',
  metadata: {
    ottoSubmissionId: submissionId,
    ottoPayloadHash: request.payloadHash,
    ottoFileIndex: index,
    sha256: request.files[index].sha256,
  },
});
const missing = {
  statusCode: 200,
  body: { data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } },
};
const upload = {
  statusCode: 200,
  body: {
    data: {
      fileUpload: {
        success: true,
        uploadFile: {
          uploadUrl:
            'https://storage.googleapis.com/linear-files/example?X-Goog-Signature=synthetic',
          assetUrl: 'https://uploads.linear.app/example/asset',
          headers: [{ key: 'x-goog-meta-example', value: 'synthetic' }],
        },
      },
    },
  },
};

test('anonymous webhook validation rejects altered payloads before reaching Linear', () => {
  const body = envelope();
  const jsCode = feedbackWorkflowNodes().find((node) => node.name === 'Validate feedback')
    .parameters.jsCode;
  const run = new Function('$input', 'require', jsCode);
  const require = createRequire(import.meta.url);
  const validate = (body) => run({ first: () => ({ json: { body } }) }, require)[0].json;
  assert.equal(validate(body).submissionId, submissionId);
  for (const category of ['feature', 'other'])
    assert.equal(validate(envelope({ category })).submissionId, submissionId);
  assert.equal(validate({ ...body, feedback: 'Changed' }).httpStatus, 400);
  assert.equal(validate({}).httpStatus, 400);
});

test('feedback bytes and metadata are bound to the canonical hash', () => {
  const value = envelope();
  const request = checkFeedback(value, hashFeedback);
  assert.equal(request.submissionId, submissionId);
  assert.equal(request.files.length, 1);
  assert.match(request.description, /App version: 0\.1\.2/);
  for (const changes of [
    { feedback: 'Changed' },
    { appVersion: '0.2.0' },
    { source: 'local-web' },
    { appModified: true },
    { computerName: 'Different Mac' },
    { report: file('{}') },
  ])
    assert.equal(checkFeedback({ ...value, ...changes }, hashFeedback).receipt.status, 'rejected');
  for (const category of ['bug', 'feature', 'other']) {
    for (const report of [undefined, file('{"synthetic":true}')]) {
      const feedback = checkFeedback(envelope({ category, report }), hashFeedback);
      assert.equal(feedback.files.length, report ? 1 : 0);
      assert.match(feedback.description, /App version: 0\.1\.2/);
    }
  }
  for (const source of ['desktop', 'local-web', 'hosted-web']) {
    const feedback = checkFeedback(
      envelope({ appVersion: null, source, appModified: true }),
      hashFeedback,
    );
    assert.equal(feedback.submissionId, submissionId);
  }
  assert.equal(
    checkFeedback(envelope({ submissionId: [submissionId] }), hashFeedback).receipt.status,
    'rejected',
  );
});

test('feedback rejects malformed and oversized content before Linear', () => {
  const cases = [
    { feedback: ' ' },
    { feedback: 'x'.repeat(12001) },
    { report: file('not JSON') },
    { report: file(' '.repeat(512 * 1024 + 1)) },
    { report: { ...file('{}'), sha256: '0'.repeat(64) } },
    { attachments: [file('not PNG', 'image/png', 'image.png')] },
    { attachments: [file('value', 'image/svg+xml', 'image.svg')] },
    { attachments: [file('not PDF', 'application/pdf', 'example.pdf')] },
    { attachments: [file(Buffer.from([0xc3, 0x28]), 'text/plain', 'invalid.txt')] },
    { attachments: [file('contains\0binary', 'text/plain', 'invalid.log')] },
    { attachments: [file('not JSON', 'application/json', 'invalid.json')] },
    { attachments: [file(Buffer.from([0xff]), 'text/csv', 'invalid.csv')] },
    { attachments: [file('x'.repeat(2 * 1024 * 1024 + 1), 'text/plain', 'oversized.txt')] },
    { attachments: Array.from({ length: 4 }, () => file('text', 'text/plain', 'extra.txt')) },
    {
      attachments: Array.from({ length: 3 }, () =>
        file('x'.repeat(1_500_000), 'text/plain', 'large.txt'),
      ),
    },
    { report: file('{}', 'application/json', '../report.json') },
    { projectId: 'arbitrary' },
    { report: 0 },
    { appVersion: undefined },
    { appVersion: ' ' },
    { appVersion: false },
    { appVersion: '0.1.2\nother' },
    { source: undefined },
    { source: 'browser' },
    { appModified: undefined },
    { appModified: 'true' },
  ];
  for (const changes of cases)
    assert.equal(checkFeedback(envelope(changes), hashFeedback).receipt.status, 'rejected');
});

test('document attachments preserve their MIME, bytes and hashes through webhook validation and private upload', () => {
  const jsCode = feedbackWorkflowNodes().find((node) => node.name === 'Validate feedback')
    .parameters.jsCode;
  const run = new Function('$input', 'require', jsCode);
  const require = createRequire(import.meta.url);
  const files = [
    file('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF', 'application/pdf', 'example.pdf'),
    file('Synthetic café report\nwith a second line.', 'text/plain', 'example.txt'),
    file('Synthetic event\tcompleted\r\n', 'text/plain', 'example.log'),
    file('# Synthetic report\n\nDetails.', 'text/plain', 'example.md'),
    file('\ufeff{"synthetic":true}', 'application/json', 'example.json'),
    file('name,status\r\nsynthetic,complete\r\n', 'text/csv', 'example.csv'),
  ];
  for (const original of files) {
    const body = envelope({ report: undefined, attachments: [original] });
    const validated = run({ first: () => ({ json: { body } }) }, require)[0].json;
    assert.equal(validated.submissionId, submissionId, original.name);
    assert.equal(validated.files.length, 1);
    const prepared = prepareFeedbackUpload(upload, validated.files[0], validated, hashFeedback);
    assert.equal(prepared.binary.file.mimeType, original.mimeType);
    assert.equal(prepared.binary.file.data, original.data);
    assert.equal(prepared.json.headers['content-type'], original.mimeType);
    assert.equal(prepared.json.attachment.metadata.sha256, original.sha256);
    assert.equal(
      checkFeedback(
        { ...body, attachments: [{ ...original, data: file('changed').data }] },
        hashFeedback,
      ).receipt.status,
      'rejected',
    );
  }
});

test('AI issue formatting preserves the original feedback and trusted receipt metadata', () => {
  const request = checkFeedback(envelope(), hashFeedback);
  const generated = {
    title: 'Example button is unavailable after opening the view',
    description: 'The reporter cannot use the example button after opening the example view.',
  };
  const output = (text) => ({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  });
  for (const value of [generated, JSON.stringify(generated)]) {
    const issue = formatFeedbackIssue(output(value), request);
    assert.equal(issue.title, generated.title);
    assert.ok(issue.description.startsWith(generated.description));
    assert.ok(
      issue.description.includes(
        request.feedback
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      ),
    );
    assert.ok(issue.description.includes(request.metadata));
    assert.ok(issue.description.endsWith(request.receiptMarker));
    assert.equal(
      feedbackReceipt(
        response(request, [attachment(request)], { description: issue.description }),
        request,
        'final',
        feedbackWorkflow,
      ).receipt.status,
      'submitted',
    );
  }
  const fallback = { title: request.title, description: request.description };
  for (const value of [
    { error: 'Unavailable' },
    { status: 'completed', output: [null] },
    { status: 'completed', output: [{ type: 'message', content: [null] }] },
    { ...output(generated), status: 'incomplete' },
    output('not JSON'),
    output({ ...generated, projectId: 'another-project' }),
    output({ ...generated, title: 'x'.repeat(161) }),
    output({ ...generated, description: '' }),
    output({ ...generated, description: 'x'.repeat(6001) }),
    output({ ...generated, title: 'One\nTwo' }),
    {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Unavailable' }] }],
    },
  ])
    assert.deepEqual(formatFeedbackIssue(value, request), fallback);
});

test('the AI formatting request includes only user-written feedback and its category', () => {
  const request = checkFeedback(
    envelope({
      attachments: [file('Synthetic private attachment content', 'text/plain', 'private.txt')],
    }),
    hashFeedback,
  );
  const node = feedbackWorkflowNodes().find((node) => node.name === 'Draft Linear issue');
  const expression = node.parameters.responses.values[0].content;
  const evaluate = new Function('$', `return (${expression.slice(3, -2)});`);
  assert.deepEqual(JSON.parse(evaluate(() => ({ first: () => ({ json: request }) }))), {
    category: 'bug',
    feedback: request.feedback,
  });
});

test('Linear HTTP expressions preserve request bindings through n8n template delimiters', () => {
  const request = checkFeedback(
    envelope({
      feedback: 'The example displays "quoted" text and }} after opening.\nPlease investigate.',
      attachments: [
        file(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), 'image/png', 'example.png'),
      ],
    }),
    hashFeedback,
  );
  const nodes = feedbackWorkflowNodes();
  const evaluate = (name, json = {}, prepared) => {
    const expression = nodes.find((node) => node.name === name).parameters.jsonBody;
    assert.ok(expression.startsWith('={{'), name);
    const closing = expression.indexOf('}}', 3);
    assert.equal(closing, expression.length - 2, `${name} closes its expression prematurely`);
    const run = new Function('$json', '$', `return (${expression.slice(3, closing)});`);
    const result = run(json, (reference) => {
      if (reference === 'Validate feedback') return { first: () => ({ json: request }) };
      assert.equal(reference, 'Validate private upload');
      return { item: prepared };
    });
    return typeof result === 'string' ? JSON.parse(result) : result;
  };
  for (const name of ['Find original issue', 'Verify feedback receipt'])
    assert.deepEqual(evaluate(name).variables, { id: request.submissionId });
  const formatted = {
    title: 'Example text contains unexpected braces',
    description: request.description,
  };
  const created = evaluate('Create Linear issue', formatted).variables.input;
  assert.equal(created.id, request.submissionId);
  assert.equal(created.title, formatted.title);
  assert.equal(created.description, formatted.description);
  for (const file of request.files) {
    assert.deepEqual(evaluate('Request private upload', { file }).variables, {
      contentType: file.mimeType,
      filename: file.name,
      size: Buffer.from(file.data, 'base64').length,
    });
    const prepared = prepareFeedbackUpload(upload, file, request, hashFeedback);
    const attached = evaluate('Attach private file', {}, prepared).variables.input;
    assert.deepEqual(attached, prepared.json.attachment);
    assert.equal(attached.issueId, request.submissionId);
    assert.equal(attached.metadata.sha256, file.sha256);
  }
});

test('status never creates an issue and uncertain GraphQL results stay uncertain', () => {
  const request = checkFeedback(envelope(), hashFeedback);
  assert.equal(feedbackReceipt(missing, request, 'initial', feedbackWorkflow).create, true);
  const status = checkFeedback(
    { action: 'status', submissionId, payloadHash: request.payloadHash },
    hashFeedback,
  );
  assert.equal(
    feedbackReceipt(missing, status, 'initial', feedbackWorkflow).receipt.status,
    'rejected',
  );
  assert.equal(
    feedbackReceipt(missing, request, 'created', feedbackWorkflow).receipt.status,
    'unknown',
  );
  assert.equal(
    feedbackReceipt(
      {
        ...response(request),
        body: { ...response(request).body, errors: [{ message: 'synthetic' }] },
      },
      request,
      'initial',
      feedbackWorkflow,
    ).receipt.status,
    'unknown',
  );
  assert.equal(
    feedbackReceipt({ error: 'timeout' }, request, 'initial', feedbackWorkflow).receipt.status,
    'unknown',
  );
});

test('receipts bind original issue, destination, payload and every attachment', () => {
  const request = checkFeedback(envelope(), hashFeedback);
  assert.equal(
    feedbackReceipt(response(request, [attachment(request)]), request, 'final', feedbackWorkflow)
      .receipt.status,
    'submitted',
  );
  assert.equal(
    feedbackReceipt(response(request), request, 'final', feedbackWorkflow).receipt.status,
    'partial',
  );
  for (const changes of [
    { id: 'other' },
    { project: { id: 'other' } },
    { team: { id: 'other' } },
    { description: request.description.replace(request.payloadHash, '0'.repeat(64)) },
    { url: 'https://linear.app.attacker.invalid/n8n/issue/LAB-1/example' },
  ])
    assert.equal(
      feedbackReceipt(
        response(request, [attachment(request)], changes),
        request,
        'final',
        feedbackWorkflow,
      ).receipt.status,
      'unknown',
    );
  const wrongHash = attachment(request);
  wrongHash.metadata.sha256 = '0'.repeat(64);
  assert.equal(
    feedbackReceipt(response(request, [wrongHash]), request, 'final', feedbackWorkflow).receipt
      .status,
    'partial',
  );
  const wrongPayload = attachment(request);
  wrongPayload.metadata.ottoPayloadHash = '0'.repeat(64);
  assert.equal(
    feedbackReceipt(response(request, [wrongPayload]), request, 'final', feedbackWorkflow).receipt
      .status,
    'partial',
  );
});

test('creation responses enter attachment delivery without another creation attempt', () => {
  const request = checkFeedback(envelope(), hashFeedback);
  const issue = response(request).body.data.issues.nodes[0];
  const created = {
    statusCode: 200,
    body: { data: { issueCreate: { success: true, issue } } },
  };
  const delivery = feedbackReceipt(created, request, 'initial', feedbackWorkflow);
  assert.equal(delivery.create, false);
  assert.deepEqual(delivery.files, request.files);
  for (const issueCreate of [null, { success: false, issue }, { success: true, issue: null }]) {
    const receipt = feedbackReceipt(
      { ...created, body: { data: { issueCreate } } },
      request,
      'initial',
      feedbackWorkflow,
    );
    assert.equal(receipt.receipt.status, 'unknown');
    assert.equal(receipt.create, undefined);
  }
  assert.equal(
    feedbackReceipt(
      { ...created, body: { ...created.body, errors: [{ message: 'synthetic failure' }] } },
      request,
      'initial',
      feedbackWorkflow,
    ).receipt.status,
    'unknown',
  );
  const withoutFiles = checkFeedback(
    envelope({ category: 'feature', report: undefined }),
    hashFeedback,
  );
  const feature = response(withoutFiles).body.data.issues.nodes[0];
  assert.equal(
    feedbackReceipt(
      { ...created, body: { data: { issueCreate: { success: true, issue: feature } } } },
      withoutFiles,
      'initial',
      feedbackWorkflow,
    ).receipt.status,
    'submitted',
  );
});

test('explicit repair selects only missing files on the original issue', () => {
  const request = checkFeedback(
    envelope({
      attachments: [
        file(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), 'image/png', 'example.png'),
      ],
    }),
    hashFeedback,
  );
  const repair = feedbackReceipt(
    response(request, [attachment(request)]),
    request,
    'initial',
    feedbackWorkflow,
  );
  assert.equal(repair.create, false);
  assert.equal(repair.submissionId, submissionId);
  assert.equal(repair.files.length, 1);
  assert.equal(repair.files[0].index, 1);
  const status = { action: 'status', submissionId, payloadHash: request.payloadHash };
  const repairRequest = checkFeedback({ ...envelope(), action: 'repair' }, hashFeedback);
  assert.equal(repairRequest.action, 'repair');
  assert.equal(
    feedbackReceipt(missing, repairRequest, 'initial', feedbackWorkflow).receipt.status,
    'rejected',
  );
  assert.equal(
    feedbackReceipt(response(repairRequest), repairRequest, 'initial', feedbackWorkflow).create,
    false,
  );
  assert.equal(
    feedbackReceipt(response(request, [attachment(request)]), status, 'initial', feedbackWorkflow)
      .receipt.status,
    'partial',
  );
  for (const category of ['feature', 'other']) {
    const original = envelope({ category });
    const submitted = checkFeedback(original, hashFeedback);
    const retry = checkFeedback({ ...original, action: 'repair' }, hashFeedback);
    const needsRepair = feedbackReceipt(response(submitted), retry, 'initial', feedbackWorkflow);
    assert.equal(needsRepair.create, false);
    assert.equal(retry.payloadHash, submitted.payloadHash);
    assert.equal(needsRepair.files[0].data, original.report.data);
    assert.equal(needsRepair.files[0].sha256, original.report.sha256);
    assert.equal(
      checkFeedback(
        { ...original, report: file('{"changed":true}'), action: 'repair' },
        hashFeedback,
      ).receipt.status,
      'rejected',
    );
  }
});

test('private upload preserves bytes and returned headers without forwarding API credentials', () => {
  const request = checkFeedback(envelope(), hashFeedback);
  const sandboxPrepare = new Function('URL', `return (${prepareFeedbackUpload.toString()});`)(
    undefined,
  );
  const prepared = sandboxPrepare(upload, request.files[0], request, hashFeedback);
  assert.equal(prepared.binary.file.data, request.files[0].data);
  assert.equal(prepared.json.headers['x-goog-meta-example'], 'synthetic');
  assert.equal(prepared.json.attachment.issueId, submissionId);
  assert.equal(prepared.json.attachment.metadata.ottoPayloadHash, request.payloadHash);
  assert.match(
    prepared.json.attachment.id,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.equal(
    prepareFeedbackUpload(upload, request.files[0], request, hashFeedback).json.attachment.id,
    prepared.json.attachment.id,
  );
  for (const change of [
    { uploadUrl: 'http://storage.googleapis.com/file?X-Goog-Signature=test' },
    { uploadUrl: 'https://127.0.0.1/file?X-Goog-Signature=test' },
    { uploadUrl: 'https://storage.googleapis.com.evil.test/file?X-Goog-Signature=test' },
    { assetUrl: 'https://uploads.linear.app/file?public=yes' },
    { headers: [{ key: 'Authorization', value: 'do-not-forward' }] },
  ]) {
    const changed = structuredClone(upload);
    Object.assign(changed.body.data.fileUpload.uploadFile, change);
    assert.throws(
      () => prepareFeedbackUpload(changed, request.files[0], request, hashFeedback),
      /Private upload could not be verified/,
    );
  }
});

test('per-item private upload preparation keeps each file paired with its upload response', () => {
  const request = checkFeedback(
    envelope({
      attachments: [
        file(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), 'image/png', 'example.png'),
      ],
    }),
    hashFeedback,
  );
  const nodes = feedbackWorkflowNodes();
  const jsCode = nodes.find((node) => node.name === 'Validate private upload').parameters.jsCode;
  const headersExpression = nodes.find((node) => node.name === 'Upload private file').parameters
    .jsonHeaders;
  const evaluateHeaders = new Function('$json', `return (${headersExpression.slice(3, -2)});`);
  const run = new Function('$json', '$', 'require', jsCode);
  const require = createRequire(import.meta.url);
  const prepared = request.files.map((file, index) => {
    const current = structuredClone(upload);
    current.body.data.fileUpload.uploadFile.assetUrl += String(index);
    current.body.data.fileUpload.uploadFile.headers.push(
      { key: 'Content-Length', value: String(file.size) },
      { key: 'Content-Disposition', value: `attachment; filename="${file.name}"` },
    );
    const result = run(
      current,
      (name) =>
        name === 'Split attachments'
          ? { item: { json: { file } } }
          : { first: () => ({ json: request }) },
      require,
    );
    assert.equal(result.binary.file.data, file.data);
    assert.equal(result.json.attachment.metadata.ottoFileIndex, index);
    assert.equal(result.json.attachment.url, current.body.data.fileUpload.uploadFile.assetUrl);
    const headers = JSON.parse(evaluateHeaders(result.json));
    assert.deepEqual(headers, result.json.headers);
    assert.equal(headers['content-length'], String(file.size));
    assert.equal(headers['content-disposition'], `attachment; filename="${file.name}"`);
    return result;
  });
  assert.notEqual(prepared[0].json.attachment.id, prepared[1].json.attachment.id);
  assert.throws(
    () =>
      run(
        { statusCode: 500 },
        (name) =>
          name === 'Split attachments'
            ? { item: { json: { file: request.files[0] } } }
            : { first: () => ({ json: request }) },
        require,
      ),
    /Private upload could not be verified/,
  );
});
