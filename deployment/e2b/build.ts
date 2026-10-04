import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Template } from 'e2b';
import { prepareE2BContext, type E2BTemplateRole } from './context.ts';

export async function prepareE2BTemplate(role: E2BTemplateRole) {
  const context = await prepareE2BContext({ role });
  try {
    const template = Template({ fileContextPath: context.path }).fromDockerfile(context.dockerfile);
    const final =
      role === 'browser'
        ? template
            .setUser('root')
            .runCmd('mkdir -p /app/deployment/e2b && chmod 755 /app/deployment /app/deployment/e2b')
            .copy('deployment/e2b/browser-ready.ts', '/app/deployment/e2b/browser-ready.ts')
            .setUser('node')
            .runCmd(
              'test -x /usr/bin/chromium && test -x /usr/bin/Xvfb && test -x /usr/bin/xauth && test -x /usr/bin/xdotool && test -x /usr/bin/ffmpeg && test -x /app/node_modules/agent-browser/bin/agent-browser-linux-x64 && test -r /app/src/providers/container-browser/bridge.ts',
            )
            .setStartCmd(
              'cd /app && exec node --import tsx /app/src/providers/container-browser/worker.ts',
              'cd /app && node --import tsx /app/deployment/e2b/browser-ready.ts',
            )
        : role === 'computer'
          ? template
              .setUser('root')
              .runCmd(
                'test -x /usr/bin/chromium && test -x /usr/bin/Xvfb && test -x /usr/sbin/nft && test -x /usr/sbin/ip && test -x /usr/bin/setpriv && test -r /app/src/providers/container-browser/bridge.ts && test -r /opt/otto/workspace-command.py && test -x /usr/bin/pdftotext && test -x /usr/bin/tesseract && test -x /usr/bin/jq && test -x /usr/local/bin/yt-dlp && test -x /usr/local/bin/save-video',
              )
              .setStartCmd(
                'exec python3 /opt/otto/computer-guard.py start',
                'python3 /opt/otto/computer-guard.py check',
              )
          : template
              .runCmd(
                'python3 -c "import ast; ast.parse(open(\'/opt/otto/workspace-command.py\').read())" && test -w /workspace && test -x /usr/local/bin/node && test -x /usr/bin/python3 && test -x /usr/bin/pipx && test -x /usr/bin/ffmpeg && test -x /usr/bin/pdftotext && test -x /usr/bin/tesseract && test -x /usr/bin/jq && test -x /usr/local/bin/yt-dlp && test -x /usr/local/bin/save-video',
              )
              .setReadyCmd('test -r /opt/otto/workspace-command.py && test -w /workspace');
    const description = await Template.toJSON(final);
    return {
      template: final,
      summary: {
        role,
        files: context.files,
        sourceSha256: context.sha256,
        templateSha256: createHash('sha256').update(description).digest('hex'),
      },
      close: context.close,
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function buildE2BTemplate(options: {
  role: E2BTemplateRole;
  name: string;
  apiKey: string;
}) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.name) || !options.apiKey.trim())
    throw new Error('A template name and E2B API key are required.');
  const prepared = await prepareE2BTemplate(options.role);
  try {
    const result = await Template.build(prepared.template, options.name, {
      apiKey: options.apiKey,
      cpuCount: 2,
      memoryMB: options.role === 'computer' ? 3072 : options.role === 'browser' ? 2048 : 1024,
      requestTimeoutMs: 30_000,
      retries: 0,
      signal: AbortSignal.timeout(30 * 60_000),
    });
    return {
      templateId: result.templateId,
      buildId: result.buildId,
      name: result.name,
      role: options.role,
      sourceSha256: prepared.summary.sourceSha256,
    };
  } finally {
    await prepared.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const role = process.argv[2];
  if (role !== 'browser' && role !== 'workspace' && role !== 'computer') {
    process.stderr.write('Choose a computer, browser or workspace template.\n');
    process.exitCode = 1;
  } else {
    try {
      let result: unknown;
      if (process.argv[3] === '--check' && process.argv.length === 4) {
        const prepared = await prepareE2BTemplate(role);
        try {
          result = { status: 'checked', ...prepared.summary };
        } finally {
          await prepared.close();
        }
      } else {
        if (process.argv.length !== 4) throw new Error();
        result = await buildE2BTemplate({
          role,
          name: process.argv[3] ?? '',
          apiKey: process.env.E2B_API_KEY ?? '',
        });
      }
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch {
      process.stderr.write('The E2B template build failed.\n');
      process.exitCode = 1;
    }
  }
}
