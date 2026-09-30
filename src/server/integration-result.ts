export const appResultInlineChars = 40_000;

export async function inlineAppResult(result: unknown, save: (text: string) => Promise<string>) {
  const text = JSON.stringify(result ?? null);
  if (text.length <= appResultInlineChars) return result;
  const bytes = Buffer.byteLength(text);
  const preview = text.slice(0, 2000);
  try {
    return {
      workspaceFile: await save(text),
      bytes,
      preview,
      message:
        'The full app result is saved in this workspace file. Inspect it with read or bash, for example jq, instead of repeating the request.',
    };
  } catch (error) {
    return {
      bytes,
      preview,
      message: `The full app result could not be saved to the workspace (${error instanceof Error ? error.message : String(error)}). Only this preview is available. Do not repeat a completed write to recover it.`,
    };
  }
}
