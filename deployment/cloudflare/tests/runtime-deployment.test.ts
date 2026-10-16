import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deploymentProof, runtimeDeploymentAcknowledgement } from '../src/runtime-deployment.ts';

const input = { nonce: randomUUID(), targetRelease: 'a'.repeat(40), deadline: Date.now() + 60_000 };

test('only the exact natural-drain acknowledgement may become a durable proof', async () => {
  const receipt = {
    ok: true,
    nonce: input.nonce,
    targetRelease: input.targetRelease,
    generation: '2',
    drained: true,
  };
  await runtimeDeploymentAcknowledgement(Response.json(receipt), input, '2', 'drain');
  for (const body of [
    { ...receipt, drained: false },
    { ...receipt, generation: '1' },
    { ...receipt, nonce: randomUUID() },
    { ...receipt, extra: true },
    { ok: true },
  ])
    await assert.rejects(
      runtimeDeploymentAcknowledgement(Response.json(body), input, '2', 'drain'),
    );
  await assert.rejects(
    runtimeDeploymentAcknowledgement(new Response('x'.repeat(2049)), input, '2', 'drain'),
  );
  await runtimeDeploymentAcknowledgement(Response.json({ ok: true }), input, '2', 'resume');
});

test('E2B drain requires an explicit remote computer pause acknowledgement', async () => {
  const receipt = {
    ok: true,
    nonce: input.nonce,
    targetRelease: input.targetRelease,
    generation: '2',
    drained: true,
  };
  for (const computerPaused of [undefined, false, 'true'])
    await assert.rejects(
      runtimeDeploymentAcknowledgement(
        Response.json({ ...receipt, computerPaused }),
        input,
        '2',
        'drain',
        true,
      ),
    );
  const accepted = { ...receipt, computerPaused: true };
  const response = await runtimeDeploymentAcknowledgement(
    Response.json(accepted),
    input,
    '2',
    'drain',
    true,
  );
  assert.deepEqual(await response.json(), accepted);
  assert.equal(
    deploymentProof({ ...input, generation: '2', computerPaused: true }, input, '2'),
    true,
  );
});
