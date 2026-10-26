import { readFile } from 'node:fs/promises';

export const installer = await readFile(new URL('./install.sh', import.meta.url), 'utf8');
export const windowsInstaller = await readFile(new URL('./install.ps1', import.meta.url), 'utf8');

export function installNodes() {
  return [
    {
      name: 'Install command',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      parameters: {
        httpMethod: 'GET',
        path: 'nod/install',
        authentication: 'none',
        responseMode: 'responseNode',
        options: {},
      },
    },
    {
      name: 'Load installer',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `return [{json:{body:${JSON.stringify(installer)}}}];`,
      },
    },
    {
      name: 'Send response',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      parameters: {
        respondWith: 'text',
        responseBody: '={{ $json.body }}',
        options: {
          responseCode: 200,
          enableStreaming: false,
          responseHeaders: {
            entries: [
              { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' },
              { name: 'Referrer-Policy', value: 'no-referrer' },
              { name: 'X-Content-Type-Options', value: 'nosniff' },
            ],
          },
        },
      },
    },
    {
      name: 'Windows install command',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      parameters: {
        httpMethod: 'GET',
        path: 'nod/install-windows',
        authentication: 'none',
        responseMode: 'responseNode',
        options: {},
      },
    },
    {
      name: 'Load Windows installer',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: `return [{json:{body:${JSON.stringify(windowsInstaller)}}}];`,
      },
    },
  ];
}

export function installWorkflowCode() {
  const declarations = installNodes().map(({ type, typeVersion, ...config }, index) => {
    const serialized = JSON.stringify(config).replace(
      JSON.stringify('={{ $json.body }}'),
      `expr(${JSON.stringify('{{ $json.body }}')})`,
    );
    return `const n${index} = ${[0, 3].includes(index) ? 'trigger' : 'node'}({type:${JSON.stringify(type)},version:${typeVersion},config:${serialized}});`;
  });
  return `import {workflow,trigger,node,expr} from '@n8n/workflow-sdk';\n${declarations.join('\n')}\nexport default workflow('nod-install','Nod Install').add(n0).to(n1).to(n2).add(n3).to(n4).to(n2);\n`;
}
