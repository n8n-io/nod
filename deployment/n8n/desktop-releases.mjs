import { createHash } from 'node:crypto';

export const base = 'https://internal.users.n8n.cloud/webhook/nod/desktop';

export function checkRequest(input) {
  const invalid = () => ({ status: 400, body: { error: 'Invalid desktop release request.' } });
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const version =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
  const id = (value) =>
    typeof value === 'string' &&
    /^[1-9]\d{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value));
  if (!record(input) || !record(input.params ?? {}) || !record(input.query ?? {})) return invalid();
  const params = input.params ?? {};
  const query = input.query ?? {};
  if (
    [...Object.values(params), ...Object.values(query)].some(
      (value) => typeof value !== 'string' || value.length > 200,
    )
  )
    return invalid();
  const keys = Object.keys(params).sort().join(',');
  const queryKeys = Object.keys(query).sort().join(',');
  const api = 'https://api.github.com/repositories/1387586059/releases';
  if (!keys && !queryKeys) return { operation: 'list', apiUrl: `${api}?per_page=100` };
  if (
    !keys &&
    ['installer', 'installer,platform'].includes(queryKeys) &&
    query.installer === 'true' &&
    (query.platform === undefined ||
      ['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(query.platform))
  )
    return {
      operation: 'installer',
      platform: query.platform || 'darwin-arm64',
      apiUrl: `${api}?per_page=100`,
    };
  if (
    keys === 'tag' &&
    !queryKeys &&
    params.tag.startsWith('nod-v') &&
    version.test(params.tag.slice(5))
  )
    return { operation: 'metadata', tag: params.tag, apiUrl: `${api}/tags/${params.tag}` };
  if (!id(params.releaseId)) return invalid();
  const request = { releaseId: Number(params.releaseId), apiUrl: `${api}/${params.releaseId}` };
  if (keys === 'releaseId' && !queryKeys) return { ...request, operation: 'metadata' };
  if (!id(params.assetId)) return invalid();
  request.assetId = Number(params.assetId);
  if (
    keys === 'assetId,filename,releaseId' &&
    !queryKeys &&
    /^[a-zA-Z0-9._-]{1,120}$/.test(params.filename) &&
    !['.', '..'].includes(params.filename)
  )
    return { ...request, operation: 'asset', filename: params.filename };
  if (
    keys === 'assetId,releaseId' &&
    queryKeys === 'platform,version' &&
    ['darwin-arm64', 'darwin-x64'].includes(query.platform) &&
    version.test(query.version)
  )
    return {
      ...request,
      operation: 'feed',
      platform: query.platform,
      currentVersion: query.version,
    };
  return invalid();
}

export function releaseResponse(pages, request, baseUrl) {
  const unavailable = () => ({
    status: 503,
    body: { error: 'Desktop downloads are unavailable. Try again later.' },
  });
  const missing = () => ({ status: 404, body: { error: 'This desktop download is unavailable.' } });
  const versionPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
  const desktopTag = (tag) =>
    typeof tag === 'string' &&
    tag.length < 140 &&
    tag.startsWith('nod-v') &&
    versionPattern.test(tag.slice(5));
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const allowed = (name) =>
    [
      'release.json',
      'runtime-release.json',
      'update.json',
      'nod-arm64.dmg',
      'nod-arm64.zip',
      'nod-x64.dmg',
      'nod-x64.zip',
      'nod-Setup-x64.exe',
      'nod-Runtime-win32-x64.tar.gz',
      'release-darwin-x64.json',
      'runtime-release-darwin-x64.json',
      'update-darwin-x64.json',
      'release-win32-x64.json',
      'SHA256SUMS-darwin-x64',
      'SHA256SUMS-win32-x64',
      'SHA256SUMS',
      'signing.cer',
      'CHANGELOG.md',
    ].includes(name) ||
    /^runtime-darwin-(arm64|x64)-[a-f0-9]{64}\.json$/.test(name) ||
    /^nod-Runtime-darwin-(arm64|x64)-[a-f0-9]{12}\.tar\.gz$/.test(name);
  const normalize = (release) => {
    if (
      !release ||
      release.draft !== false ||
      !release.published_at ||
      !Number.isFinite(Date.parse(release.published_at))
    )
      return null;
    if (!desktopTag(release.tag_name)) return null;
    if (!positive(release.id) || !Array.isArray(release.assets) || release.assets.length > 100)
      throw new Error('Invalid release.');
    const names = new Set();
    const ids = new Set();
    const assets = release.assets
      .filter((asset) => asset && allowed(asset.name))
      .map((asset) => {
        if (
          !positive(asset.id) ||
          !positive(asset.size) ||
          asset.state !== 'uploaded' ||
          !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
          names.has(asset.name) ||
          ids.has(asset.id)
        )
          throw new Error('Invalid asset.');
        names.add(asset.name);
        ids.add(asset.id);
        const url = `${baseUrl}/releases/${release.id}/assets/${asset.id}/${asset.name}`;
        return {
          id: asset.id,
          name: asset.name,
          size: asset.size,
          digest: asset.digest,
          state: asset.state,
          content_type: asset.content_type,
          url,
          browser_download_url: url,
        };
      });
    return {
      id: release.id,
      tag_name: release.tag_name,
      name: typeof release.name === 'string' ? release.name.slice(0, 200) : release.tag_name,
      draft: false,
      prerelease: release.prerelease === true,
      published_at: release.published_at,
      assets,
      url: `${baseUrl}/releases/${release.id}`,
    };
  };
  const compare = (left, right) => {
    const a = versionPattern.exec(left);
    const b = versionPattern.exec(right);
    if (!a || !b) throw new Error('Invalid version.');
    for (let index = 1; index <= 3; index++) {
      if (BigInt(a[index]) !== BigInt(b[index]))
        return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
    }
    if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
    const aa = a[4].split('.');
    const bb = b[4].split('.');
    for (let index = 0; index < Math.max(aa.length, bb.length); index++) {
      if (aa[index] === bb[index]) continue;
      if (aa[index] === undefined || bb[index] === undefined)
        return aa[index] === undefined ? -1 : 1;
      const an = /^\d+$/.test(aa[index]);
      const bn = /^\d+$/.test(bb[index]);
      if (an && bn) return BigInt(aa[index]) > BigInt(bb[index]) ? 1 : -1;
      if (an !== bn) return an ? -1 : 1;
      return aa[index] > bb[index] ? 1 : -1;
    }
    return 0;
  };
  try {
    if (!Array.isArray(pages) || !pages.length || pages.length > 5) return unavailable();
    if (pages.some((page) => page.statusCode !== 200))
      return pages.length === 1 &&
        pages[0].statusCode === 404 &&
        !['list', 'installer'].includes(request.operation)
        ? missing()
        : unavailable();
    if (['list', 'installer'].includes(request.operation)) {
      if (
        pages.some((page) => !Array.isArray(page.body) || page.body.length > 100) ||
        (pages.length === 5 && pages[4].body.length === 100)
      )
        return unavailable();
      const releases = pages
        .flatMap((page) => page.body)
        .map(normalize)
        .filter(Boolean);
      if (request.operation === 'list') return { status: 200, body: releases };
      const latest = releases
        .filter((release) => desktopTag(release.tag_name))
        .sort((a, b) => compare(b.tag_name.slice(5), a.tag_name.slice(5)))[0];
      if (!latest) return missing();
      const file = (asset) => ({
        url: asset.url,
        bytes: asset.size,
        sha256: asset.digest.slice(7),
      });
      if (request.platform === 'win32-x64') {
        const [installer, runtime, manifest] = [
          'nod-Setup-x64.exe',
          'nod-Runtime-win32-x64.tar.gz',
          'release-win32-x64.json',
        ].map((name) => latest.assets.find((asset) => asset.name === name));
        if (!installer || !runtime || !manifest || manifest.size > 2 * 1024 * 1024)
          return unavailable();
        return {
          status: 200,
          body: {
            schema: 1,
            version: latest.tag_name.slice(5),
            releaseId: latest.id,
            installer: file(installer),
            runtime: file(runtime),
            manifestUrl: manifest.url,
          },
        };
      }
      const arch = request.platform === 'darwin-x64' ? 'x64' : 'arm64';
      const disk = latest.assets.find((asset) => asset.name === `nod-${arch}.dmg`);
      const manifest = latest.assets.find(
        (asset) => asset.name === (arch === 'x64' ? 'release-darwin-x64.json' : 'release.json'),
      );
      if (!disk || !manifest || manifest.size > 2 * 1024 * 1024) return unavailable();
      return {
        status: 200,
        body: {
          schema: 1,
          version: latest.tag_name.slice(5),
          releaseId: latest.id,
          disk: file(disk),
          manifestUrl: manifest.url,
        },
      };
    }
    if (pages.length !== 1) return unavailable();
    const release = normalize(pages[0].body);
    if (
      !release ||
      (request.releaseId && release.id !== request.releaseId) ||
      (request.tag && release.tag_name !== request.tag)
    )
      return missing();
    if (request.operation === 'metadata') return { status: 200, body: release };
    const asset = release.assets.find((entry) => entry.id === request.assetId);
    if (!asset) return missing();
    if (request.operation === 'asset') {
      if (asset.name !== request.filename) return missing();
      const result = {
        assetUrl: `https://api.github.com/repositories/1387586059/releases/assets/${asset.id}`,
      };
      if (asset.name.endsWith('.json')) {
        if (asset.size > 2 * 1024 * 1024) return unavailable();
        result.metadata = { bytes: asset.size, digest: asset.digest };
      }
      return result;
    }
    if (
      request.operation !== 'feed' ||
      !desktopTag(release.tag_name) ||
      asset.name !== `nod-${request.platform === 'darwin-x64' ? 'x64' : 'arm64'}.zip`
    )
      return missing();
    const version = release.tag_name.slice(5);
    if (compare(version, request.currentVersion) <= 0) return { status: 204, body: '' };
    return {
      status: 200,
      body: {
        url: asset.browser_download_url,
        name: `nod ${version}`,
        pub_date: release.published_at,
      },
    };
  } catch {
    return unavailable();
  }
}

export function checkRedirect(response, metadata) {
  const unavailable = () => ({
    status: 503,
    body: { error: 'Desktop downloads are unavailable. Try again later.' },
  });
  if (response?.statusCode === 200) {
    if (
      !metadata ||
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes < 1 ||
      metadata.bytes > 2 * 1024 * 1024 ||
      typeof response.body !== 'string' ||
      response.body.length > 2 * 1024 * 1024 ||
      Buffer.byteLength(response.body) !== metadata.bytes ||
      `sha256:${createHash('sha256').update(response.body).digest('hex')}` !== metadata.digest
    )
      return unavailable();
    try {
      return { status: 200, body: JSON.parse(response.body) };
    } catch {
      return unavailable();
    }
  }
  if (
    !response ||
    response.statusCode !== 302 ||
    !response.headers ||
    typeof response.headers !== 'object'
  )
    return unavailable();
  const entries = Object.entries(response.headers).filter(
    ([key]) => key.toLowerCase() === 'location',
  );
  if (entries.length !== 1 || typeof entries[0][1] !== 'string') return unavailable();
  const location = entries[0][1];
  if (
    location.length > 16384 ||
    /[\s\x00-\x1f\x7f]/.test(location) ||
    !/^https:\/\/release-assets\.githubusercontent\.com(?::443)?\/[^?#\s\\]+(?:\?[^#\s\\]*)?$/.test(
      location,
    )
  )
    return unavailable();
  return { status: 302, body: '', location };
}

export const settings = {
  executionOrder: 'v1',
  availableInMCP: true,
  saveExecutionProgress: false,
  saveManualExecutions: false,
  saveDataErrorExecution: 'none',
  saveDataSuccessExecution: 'none',
  executionTimeout: 90,
};

export function workflowNodes() {
  const credentials = { githubApi: { id: 'MMbt6yeENYWprLlw', name: 'nod Releases' } };
  const response = { fullResponse: true, neverError: true, responseFormat: 'json' };
  const options = {
    timeout: 8000,
    redirect: { redirect: { followRedirects: false } },
    sendCredentialsOnCrossOriginRedirect: false,
    response: { response },
  };
  const headers = {
    parameters: [
      { name: 'Accept', value: 'application/vnd.github+json' },
      { name: 'X-GitHub-Api-Version', value: '2022-11-28' },
    ],
  };
  const condition = (leftValue) => ({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        { leftValue, operator: { type: 'boolean', operation: 'true', singleValue: true } },
      ],
      combinator: 'and',
    },
    options: {},
  });
  const triggers = [
    ['List desktop releases', 'releases'],
    ['Read desktop release', 'releases/:releaseId'],
    ['Find release tag', 'tags/:tag'],
    ['Download desktop asset', 'releases/:releaseId/assets/:assetId/:filename'],
    ['Read pinned update feed', 'releases/:releaseId/feed/:assetId'],
  ].map(([name, path]) => ({
    name,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2.1,
    webhookId: 'nod',
    parameters: {
      httpMethod: 'GET',
      path: path.includes(':') ? `desktop/${path}` : `nod/desktop/${path}`,
      authentication: 'none',
      responseMode: 'responseNode',
      options: {},
    },
    output: [{ json: { params: {}, query: {} } }],
  }));
  return [
    ...triggers,
    {
      name: 'Check desktop request',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `return [{json:(${checkRequest.toString()})($input.first().json)}];`,
      },
      output: [
        {
          json: {
            operation: 'list',
            status: 0,
            apiUrl: 'https://api.github.com/repositories/1387586059/releases?per_page=100',
          },
        },
      ],
    },
    {
      name: 'Valid desktop request',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.3,
      parameters: condition('={{ !$json.status }}'),
      output: [{ json: {} }],
    },
    {
      name: 'Read published releases',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      credentials,
      onError: 'continueRegularOutput',
      parameters: {
        method: 'GET',
        url: '={{ $json.apiUrl }}',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'githubApi',
        sendHeaders: true,
        headerParameters: headers,
        options: {
          ...options,
          pagination: {
            pagination: {
              paginationMode: 'updateAParameterInEachRequest',
              parameters: {
                parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }],
              },
              paginationCompleteWhen: 'other',
              completeExpression:
                "={{ !['list','installer'].includes($('Check desktop request').first().json.operation) || $response.statusCode !== 200 || !Array.isArray($response.body) || $response.body.length < 100 }}",
              limitPagesFetched: true,
              maxRequests: 5,
            },
          },
        },
      },
      output: [{ json: { statusCode: 200, body: [] } }],
    },
    {
      name: 'Build desktop response',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `return [{json:(${releaseResponse.toString()})($input.all().map(item=>item.json),$('Check desktop request').first().json,${JSON.stringify(base)})}];`,
      },
      output: [{ json: { status: 200, body: [], assetUrl: '', metadata: null } }],
    },
    {
      name: 'Resolve asset redirect',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.3,
      parameters: condition('={{ !!$json.assetUrl }}'),
      output: [{ json: {} }],
    },
    {
      name: 'Read GitHub asset redirect',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      credentials,
      onError: 'continueRegularOutput',
      parameters: {
        method: "={{ $json.metadata ? 'GET' : 'HEAD' }}",
        url: '={{ $json.assetUrl }}',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'githubApi',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Accept', value: 'application/octet-stream' },
            headers.parameters[1],
          ],
        },
        options: {
          ...options,
          response: {
            response: { ...response, responseFormat: 'text', outputPropertyName: 'body' },
          },
        },
      },
      output: [
        {
          json: {
            statusCode: 302,
            headers: {
              location:
                'https://release-assets.githubusercontent.com/fixture/asset?signature=synthetic',
            },
          },
        },
      ],
    },
    {
      name: 'Check GitHub redirect',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `const {createHash}=require('crypto'); return [{json:(${checkRedirect.toString()})($input.first().json,$('Build desktop response').first().json.metadata)}];`,
      },
      output: [
        {
          json: {
            status: 302,
            body: '',
            location:
              'https://release-assets.githubusercontent.com/fixture/asset?signature=synthetic',
          },
        },
      ],
    },
    {
      name: 'Send desktop response',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      parameters: {
        respondWith: 'text',
        responseBody:
          "={{ typeof $json.body === 'string' ? $json.body : JSON.stringify($json.body) }}",
        options: {
          responseCode: '={{ $json.status }}',
          enableStreaming: false,
          responseHeaders: {
            entries: [
              { name: 'Content-Type', value: 'application/json; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' },
              { name: 'Referrer-Policy', value: 'no-referrer' },
              { name: 'X-Content-Type-Options', value: 'nosniff' },
              { name: 'Location', value: "={{ $json.location || '' }}" },
            ],
          },
        },
      },
      output: [{ json: {} }],
    },
  ];
}

export function workflowCode() {
  const literal = (value) =>
    typeof value === 'string' && value.startsWith('={{')
      ? `expr(${JSON.stringify(value.slice(1))})`
      : Array.isArray(value)
        ? `[${value.map(literal).join(',')}]`
        : value && typeof value === 'object'
          ? `{${Object.entries(value)
              .map(([key, item]) => `${JSON.stringify(key)}:${literal(item)}`)
              .join(',')}}`
          : JSON.stringify(value);
  const nodes = workflowNodes();
  const declarations = nodes
    .map(
      ({ typeVersion, type, output, ...config }, index) =>
        `const n${index} = ${index < 5 ? 'trigger' : type === 'n8n-nodes-base.if' ? 'ifElse' : 'node'}(${literal({ ...(type === 'n8n-nodes-base.if' ? {} : { type }), version: typeVersion, config, output })});`,
    )
    .join('\n');
  return `import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';\n${declarations}\nexport default workflow('nod-desktop-releases','Nod Desktop Releases')\n.add(n0).to(n5).to(n6.onTrue(n7.to(n8).to(n9)).onFalse(n12))\n.add(n9.onTrue(n10.to(n11).to(n12)).onFalse(n12))
.add(n1).to(n5).add(n2).to(n5).add(n3).to(n5).add(n4).to(n5)\n.group('Serve published desktop assets',[n5,n6,n7,n8,n9,n10,n11,n12],{description:'Validate fixed-repository release and asset identities, then return metadata, an exact update feed, or a temporary asset redirect.'});\n`;
}
