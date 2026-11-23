import assert from 'node:assert/strict';
import test from 'node:test';

test('openrouter routing variants suffix the catalog ids', async () => {
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const { modelKeyCredential } = await import('../src/server/models.ts');
  const backend = createPiModelBackend({
    fetch: async (input) => {
      if (String(input) === 'https://openrouter.ai/api/v1/key')
        return Response.json({ data: { is_management_key: false } });
      return Response.json({
        data: [
          {
            id: 'openai/gpt-6.1-sol',
            name: 'GPT-6.1 Sol',
            context_length: 100000,
            supported_parameters: ['tools', 'reasoning'],
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            pricing: { prompt: '0.000002', completion: '0.00001' },
          },
        ],
      });
    },
  });
  const catalog = (variant?: 'standard' | 'nitro' | 'cost') =>
    backend.catalog(
      'openrouter',
      'api_key',
      modelKeyCredential('openrouter', 'fixture-router-key', variant ? { variant } : {}),
    );
  const [standard] = await catalog();
  assert.equal(standard.choice.id, 'openai/gpt-6.1-sol');
  assert.equal(standard.spec.id, 'openai/gpt-6.1-sol');
  const [nitro] = await catalog('nitro');
  assert.equal(nitro.choice.id, 'openai/gpt-6.1-sol:nitro');
  assert.equal(nitro.spec.id, 'openai/gpt-6.1-sol:nitro');
  assert.match(nitro.choice.name, /nitro/);
  const [cost] = await catalog('cost');
  assert.equal(cost.spec.id, 'openai/gpt-6.1-sol:cost');
  const [plain] = await catalog('standard');
  assert.equal(plain.choice.id, 'openai/gpt-6.1-sol');
  assert.throws(
    () => modelKeyCredential('openrouter', 'fixture-router-key', { variant: 'fastest' }),
    /variant/,
  );
});
