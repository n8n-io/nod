export const modelCatalog = {
  openai: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', recommended: true }],
  anthropic: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', recommended: true }],
};

export function selectedModel(settings) {
  return settings.model || modelCatalog[settings.provider][0].id;
}

export function availableModels(settings) {
  const models = structuredClone(modelCatalog);
  if (settings.model && !models[settings.provider].some(({ id }) => id === settings.model))
    models[settings.provider].push({
      id: settings.model,
      label: `${settings.model} (current)`,
      recommended: false,
    });
  return models;
}
