import { z } from 'zod';
import type { RuntimeTransport } from '../../ports/runtime-transport.ts';

export function createCloudflareRuntimeTransport(
  options: { fetch?: typeof fetch } = {},
): RuntimeTransport {
  const request = options.fetch ?? fetch;
  async function boundedResponse(response: Response) {
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) throw new Error();
        chunks.push(next.value);
      }
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function control(path: string, body: unknown) {
    try {
      const response = await request(`http://otto.runtime/runtime/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(path === 'start' ? 45_000 : 15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      return await boundedResponse(response);
    } catch {
      throw new Error('The account computer service is unavailable.');
    }
  }
  return {
    async deploymentStopped(ownerId, generation) {
      try {
        z.uuid().parse(ownerId);
        z.string()
          .regex(/^[1-9]\d{0,19}$/)
          .nullable()
          .parse(generation);
        return z
          .object({ stopped: z.boolean(), generation: z.literal(generation) })
          .strict()
          .parse(await control('deployment-stopped', { ownerId, generation })).stopped;
      } catch {
        throw new Error('The account runtime could not be verified as stopped.');
      }
    },
    async deploymentClosed() {
      return z
        .object({ closed: z.boolean() })
        .strict()
        .parse(await control('deployment-status', {})).closed;
    },
    async status(ownerId) {
      return z
        .object({
          generation: z
            .string()
            .regex(/^[1-9]\d*$/)
            .nullable(),
          stopped: z.boolean(),
        })
        .parse(await control('status', { ownerId }));
    },
    async start({ ownerId, generation, environment }) {
      const result = z
        .object({ ok: z.literal(true), generation: z.literal(generation) })
        .parse(await control('start', { ownerId, env: environment }));
      if (!result.ok) throw new Error('The account computer service is unavailable.');
    },
    async stop(ownerId, generation) {
      const deadline = Date.now() + 20_000;
      while (true) {
        try {
          z.object({ stopped: z.literal(true) }).parse(
            await control('stop', { ownerId, generation }),
          );
          return;
        } catch {
          if (Date.now() >= deadline) throw new Error('The account runtime could not be stopped.');
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
    async prepareDeployment(ownerId, generation, input) {
      try {
        z.uuid().parse(ownerId);
        const remaining = input.deadline - Date.now();
        if (remaining <= 0 || remaining > 600_000) throw new Error();
        const response = await request('http://otto.runtime/runtime/prepare-deployment', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ownerId, generation, ...input }),
          redirect: 'error',
          signal: AbortSignal.timeout(remaining),
        });
        const result = await boundedResponse(response);
        if (
          response.status === 409 &&
          z
            .object({
              ok: z.literal(false),
              status: z.literal('busy'),
              generation: z.literal(generation),
            })
            .strict()
            .safeParse(result).success
        )
          return 'busy';
        if (response.status !== 200) throw new Error();
        z.object({
          ok: z.literal(true),
          generation: z.literal(generation),
          clean: z.literal(true),
          stopped: z.literal(true),
        })
          .strict()
          .parse(result);
        return 'stopped';
      } catch {
        throw new Error('The account runtime could not be prepared for deployment.');
      }
    },
    async removeStorage(ownerId, dryRun) {
      try {
        z.uuid().parse(ownerId);
        const response = await request('http://otto.runtime/runtime/remove-storage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ownerId, dryRun }),
          redirect: 'error',
          signal: AbortSignal.timeout(300_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error();
        }
        return z
          .object({ objects: z.number().int().nonnegative() })
          .strict()
          .parse(await boundedResponse(response)).objects;
      } catch {
        throw new Error('The account files could not be removed.');
      }
    },
    fetch(ownerId, input) {
      z.uuid().parse(ownerId);
      const url = new URL(input.url);
      return request(
        new Request(`http://otto.runtime/${ownerId}${url.pathname}${url.search}`, input),
        { redirect: 'manual' },
      );
    },
    async close() {},
  };
}
