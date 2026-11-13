import { modelServiceError } from '../model-error.ts';
import { openAIRegions, type OpenAIRegion } from '../../shared/models.ts';

export function openAIBaseUrl(region: OpenAIRegion = 'global') {
  if (!Object.hasOwn(openAIRegions, region)) throw new Error('Choose an OpenAI API region.');
  return `https://${region === 'global' ? '' : `${region}.`}api.openai.com/v1`;
}

export function openAIRequestError(response: Response, key: string) {
  return modelServiceError(response, 'OpenAI API request', [key]);
}
