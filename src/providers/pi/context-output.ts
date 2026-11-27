import { createHash } from 'node:crypto';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { WorkspaceSession } from '../../ports/computer.ts';
import { untrustedBlock, untrustedParts } from '../../shared/untrusted.ts';
import { writeWorkspaceFile } from './sandbox.ts';

const imageExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

export function toolOutputReference(
  name: string,
  content: Array<TextContent | ImageContent>,
  pointer: string,
) {
  return untrustedBlock(
    name === 'skills' &&
      content.some(
        (part) =>
          part.type === 'text' && part.text.startsWith(untrustedParts('learned skill').open),
      )
      ? 'learned skill'
      : name,
    pointer,
  );
}

export function createContextOutput(workspace: WorkspaceSession, ownerHeader?: string) {
  const files = new Map<string, string>();
  const save = async (
    content: Array<TextContent | ImageContent>,
    previewCharacters: number,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    const key = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    let file = files.get(key);
    if (!file) {
      const directory = `${workspace.path}/.nod/outputs`;
      const { exitCode } = await workspace.exec(
        `mkdir -p -- '${directory.replaceAll("'", "'\\''")}'`,
        { signal },
      );
      if (exitCode)
        throw new Error(`Could not create the context output folder (exit ${exitCode}).`);
      const stem = `.nod/outputs/${key}`;
      file = `${stem}.txt`;
      if (content.some((part) => part.type === 'image')) {
        const saved = [];
        for (const [index, part] of content.entries()) {
          const mime =
            part.type === 'image' ? part.mimeType.toLowerCase().split(';')[0]!.trim() : '';
          const path = `${stem}-${index}.${part.type === 'image' ? (imageExtensions[mime] ?? 'bin') : 'txt'}`;
          await writeWorkspaceFile(
            workspace,
            `${workspace.path}/${path}`,
            part.type === 'image' ? Buffer.from(part.data, 'base64') : Buffer.from(part.text),
            signal,
          );
          saved.push(
            part.type === 'image'
              ? { type: 'image', path, mimeType: part.mimeType }
              : { type: 'text', path },
          );
        }
        file = `${stem}.json`;
        await writeWorkspaceFile(
          workspace,
          `${workspace.path}/${file}`,
          Buffer.from(JSON.stringify({ content: saved })),
          signal,
        );
      } else
        await writeWorkspaceFile(workspace, `${workspace.path}/${file}`, Buffer.from(text), signal);
      files.set(key, file);
    }
    const tail = Math.floor(previewCharacters / 2);
    return JSON.stringify({
      workspaceFile: file,
      characters: text.length,
      preview: text.length > previewCharacters ? text.slice(0, previewCharacters - tail) : text,
      ...(tail && text.length > previewCharacters ? { tail: text.slice(-tail) } : {}),
    });
  };
  return {
    save,
    async bound(
      message: Parameters<typeof estimateTokens>[0],
      limit: number,
      signal?: AbortSignal,
    ) {
      if (message.role === 'system' || !('content' in message) || estimateTokens(message) <= limit)
        return message;
      const content =
        typeof message.content === 'string'
          ? [{ type: 'text' as const, text: message.content }]
          : message.content.filter((part) => part.type === 'text' || part.type === 'image');
      if (!content.length) return message;
      const pointer = await save(content, 1000, signal);
      const text =
        message.role === 'toolResult' && !message.isError
          ? toolOutputReference(message.toolName, content, pointer)
          : (message.role === 'user' || message.role === 'custom') &&
              ownerHeader &&
              content.some((part) => part.type === 'text' && part.text.startsWith(ownerHeader))
            ? `${ownerHeader}\n${pointer}`
            : pointer;
      const replacement = [{ type: 'text' as const, text }];
      const next =
        message.role === 'assistant'
          ? {
              ...message,
              content: [...message.content.filter((part) => part.type !== 'text'), ...replacement],
            }
          : { ...message, content: replacement };
      return estimateTokens(next) < estimateTokens(message) ? next : message;
    },
  };
}
