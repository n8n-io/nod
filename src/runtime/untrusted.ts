import type { AgentToolResult } from '../ports/agent.ts';
import { neutralised, untrustedParts } from '../shared/untrusted.ts';

export function resultText(result: AgentToolResult) {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

export function delimit(source: string, result: AgentToolResult): AgentToolResult {
  const { open, close } = untrustedParts(source);
  const content = result.content.map((part) =>
    part.type === 'text' ? { ...part, text: neutralised(part.text) } : part,
  );
  return {
    ...result,
    content: content.every((part) => part.type === 'text')
      ? [
          {
            type: 'text',
            text: `${open}\n\n${content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')}\n${close}`,
          },
        ]
      : [{ type: 'text', text: open }, ...content, { type: 'text', text: close }],
  };
}
