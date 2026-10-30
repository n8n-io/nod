import type { AgentToolResult } from '../ports/agent.ts';
import { neutralised, untrustedParts } from '../shared/untrusted.ts';
import { localResultTimes } from './time-context.ts';

export function delimit(
  source: string,
  result: AgentToolResult,
  timeZone?: string,
): AgentToolResult {
  const { open, close } = untrustedParts(source);
  const content = result.content.map((part) =>
    part.type === 'text' ? { ...part, text: neutralised(part.text) } : part,
  );
  const times = localResultTimes(
    content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    timeZone,
    source === 'codemode',
  );
  if (times) content.unshift({ type: 'text', text: times });
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
