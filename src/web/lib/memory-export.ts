import { ApiError, apiResponse } from './api';

export async function exportMemory() {
  const response = await apiResponse('/api/memory/export', { cache: 'no-store' });
  if (!response.ok)
    throw new ApiError('Your memory could not be exported. Try again.', response.status);
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
    'nod-memory.md';
  const url = URL.createObjectURL(await response.blob());
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
