import { apiResponse, responseError } from './api';

export async function downloadExport(path: string, fallbackName: string) {
  const response = await apiResponse(path, { cache: 'no-store' });
  if (!response.ok) throw await responseError(response);
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
    fallbackName;
  const url = URL.createObjectURL(await response.blob());
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
