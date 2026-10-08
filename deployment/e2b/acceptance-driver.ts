import { readFile } from 'node:fs/promises';
import { Sandbox, SandboxNotFoundError } from 'e2b';
import { z } from 'zod';
import { createE2BClient } from '../../src/providers/e2b/client.ts';
import {
  acceptanceMetadata,
  type AcceptanceDriver,
  type AcceptancePlan,
  type ResourceInfo,
} from './acceptance.ts';

const failed = () => new Error('The development provider check did not complete safely.');
const count = z.number().int().min(0).max(100);
const roleBoundarySchema = (uid: 1000 | 1002) =>
  z
    .object({
      uid: z.literal(uid),
      networkDenied: count,
      privateDenied: z.literal(13),
      firewallDenied: z.literal(true),
      x11Denied: z.literal(true),
      privilegeDenied: z.literal(true),
      internetDnsFiles: z.literal(true),
    })
    .strict();
const boundarySchema = z
  .object({
    passed: z.literal(true),
    version: z.literal(2),
    readinessChecks: z.literal(2),
    rootNetAdmin: z.literal(true),
    browserCdpAndX11: z.literal(true),
    loopbackIpv4: z.literal(1),
    loopbackIpv6: z.literal(1),
    ownInterfaceIpv4: count,
    ownInterfaceIpv6: count,
    envdTcpControls: z.literal(2),
    roles: z
      .object({
        workspace: roleBoundarySchema(1000),
        connected: roleBoundarySchema(1002),
      })
      .strict(),
    workspaceConnectedPrivateDenied: z.literal(5),
    connectedCliSealed: z.literal(true),
    firewallUnchanged: z.literal(true),
    cleanupComplete: z.literal(true),
  })
  .strict();

export function createAcceptanceDriver(apiKey: string, plan: AcceptancePlan): AcceptanceDriver {
  const connection = { apiKey, requestTimeoutMs: 10_000, retries: 0 };
  const expected = acceptanceMetadata(plan);
  function match(info: ResourceInfo) {
    if (
      info.templateId !== plan.templateId ||
      Object.entries(expected).some(([key, value]) => info.metadata[key] !== value)
    )
      throw failed();
    return info;
  }
  async function inspect(id: string): Promise<ResourceInfo | null> {
    try {
      const info = await Sandbox.getInfo(id, connection);
      if (info.sandboxId !== id) throw failed();
      return match({
        id: info.sandboxId,
        templateId: info.templateId,
        metadata: info.metadata,
        state: info.state,
      });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return null;
      throw failed();
    }
  }
  return {
    client: createE2BClient({
      apiKey,
      requestTimeoutMs: 10_000,
      sandboxTimeoutMs: 20 * 60_000,
      retries: 0,
    }),
    inspect,
    async find(metadata) {
      if (JSON.stringify(metadata) !== JSON.stringify(expected)) throw failed();
      const pager = Sandbox.list({
        ...connection,
        query: { metadata, template: plan.templateId },
        limit: 2,
      });
      const infos = await pager.nextItems(connection);
      if (pager.hasNext || infos.length > 1) throw failed();
      return infos.map((info) =>
        match({
          id: info.sandboxId,
          templateId: info.templateId,
          metadata: info.metadata,
          state: info.state,
        }),
      );
    },
    async boundary(id) {
      const info = await inspect(id);
      if (!info || info.state !== 'running') throw failed();
      const script = await readFile(new URL('./live-boundary.py', import.meta.url), 'utf8');
      if (Buffer.byteLength(script) > 64 * 1024) throw failed();
      const sandbox = await Sandbox.connect(id, {
        ...connection,
        timeoutMs: 20 * 60_000,
        onResume: 'restore',
      });
      if (sandbox.sandboxId !== id) throw failed();
      await sandbox.files.write('/run/otto/live-boundary.py', script, {
        user: 'root',
        requestTimeoutMs: 10_000,
      });
      let bytes = 0;
      const output = (data: string) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 4096) throw failed();
      };
      const result = await sandbox.commands.run(
        'chmod 600 /run/otto/live-boundary.py && exec python3 /run/otto/live-boundary.py --disposable',
        {
          user: 'root',
          envs: {},
          timeoutMs: 150_000,
          requestTimeoutMs: 10_000,
          onStdout: output,
          onStderr: output,
        },
      );
      if (result.exitCode !== 0 || result.stderr !== '' || Buffer.byteLength(result.stdout) > 4096)
        throw failed();
      const parsed = boundarySchema.parse(JSON.parse(result.stdout));
      const networkTargets = 4 + parsed.ownInterfaceIpv4 + parsed.ownInterfaceIpv6;
      if (
        parsed.roles.workspace.networkDenied !== networkTargets ||
        parsed.roles.connected.networkDenied !== networkTargets ||
        parsed.ownInterfaceIpv4 + parsed.ownInterfaceIpv6 > 16
      )
        throw failed();
      return parsed;
    },
    async kill(id) {
      if (!(await inspect(id))) throw failed();
      await Sandbox.kill(id, connection);
    },
  };
}
