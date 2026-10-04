async function responseData(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) return;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function validateProviderKey(provider, key, model, send = fetch) {
  const openai = provider === 'openai';
  if (!openai && provider !== 'anthropic') throw new Error('Choose a supported model provider.');
  const name = openai ? 'OpenAI' : 'Anthropic';
  if (model !== undefined && (typeof model !== 'string' || !model || model.length > 256))
    throw new Error('Choose a supported model provider.');
  const endpoint = openai
    ? 'https://api.openai.com/v1/models'
    : 'https://api.anthropic.com/v1/models';
  let response;
  try {
    response = await send(model ? `${endpoint}/${encodeURIComponent(model)}` : endpoint, {
      method: 'GET',
      headers: openai
        ? { authorization: `Bearer ${key}` }
        : { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
  } catch {
    throw new Error(`${name} could not be reached. Check your connection and try again.`);
  }
  if (openai && response.status === 403) {
    const body = await responseData(response, 4096);
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
    if (
      typeof message === 'string' &&
      /Missing scopes:\s*api\.model\.read(?:\.|\s*$)/.test(message)
    )
      return;
  }
  if (model && response.ok) {
    const body = await responseData(response, 65_536);
    if (
      typeof body?.id !== 'string' ||
      !body.id ||
      body.id.length > 256 ||
      (openai ? body.object !== 'model' || body.id !== model : body.type !== 'model')
    )
      throw new Error(`${name} could not verify Otto's model right now. Try again shortly.`);
    return;
  }
  await response.body?.cancel().catch(() => {});
  if (model && response.status === 404)
    throw new Error(
      `${name} did not make Otto's model available to this key. Check model access in your provider account, try another key, or choose the other provider.`,
    );
  if (response.status === 401 || response.status === 403)
    throw new Error(
      `${name} did not accept this key or its model permissions. Check the key and try again.`,
    );
  if (!response.ok)
    throw new Error(`${name} could not verify the key right now. Try again shortly.`);
}
