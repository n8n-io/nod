import { randomUUID } from 'node:crypto';
import type { Api, AssistantMessage, Context, Message, Model } from '@earendil-works/pi-ai';
import type { ModelTrace } from '../../ports/traces.ts';
import { piUsageMetrics } from './usage.ts';

export interface PiModelCall {
  model: Model<Api>;
  context: Context;
  message: AssistantMessage;
  startedAt: string;
}

function text(content: string | { type: string; text?: string }[]) {
  if (typeof content === 'string') return content;
  return content
    .flatMap((block) =>
      block.type === 'text' && block.text
        ? [block.text]
        : block.type === 'image'
          ? ['[image]']
          : [],
    )
    .join('\n');
}

function chat(message: Message) {
  if (message.role === 'system')
    return {
      role: 'system',
      content: [
        text(message.content),
        ...Object.entries(message.sections ?? {}).flatMap(([name, section]) =>
          name === 'addendum' || section === null ? [] : [section],
        ),
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
  if (message.role === 'user') return { role: 'user', content: text(message.content) };
  if (message.role === 'toolResult')
    return { role: 'tool', tool_call_id: message.toolCallId, content: text(message.content) };
  const reasoning = message.content.flatMap((block) =>
    block.type === 'thinking' && block.thinking ? [block.thinking] : [],
  );
  const calls = message.content.flatMap((block) => (block.type === 'toolCall' ? [block] : []));
  return {
    role: 'assistant',
    content: text(message.content.flatMap((block) => (block.type === 'text' ? [block] : []))),
    ...(reasoning.length ? { reasoning_content: reasoning.join('\n') } : {}),
    ...(calls.length
      ? {
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
      : {}),
  };
}

export function piModelTrace(
  call: PiModelCall,
  metadata: Record<string, string>,
  ownerContext?: string,
): ModelTrace {
  const { message } = call;
  const header = ownerContext?.split('\n', 1)[0];
  const usage = piUsageMetrics(message.usage);
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const inputTokens = (usage.inputTokens ?? 0) + cacheReadTokens + cacheWriteTokens;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    id: randomUUID(),
    name: call.model.id,
    provider: call.model.provider,
    startedAt: call.startedAt,
    endedAt: new Date().toISOString(),
    messages: [
      ...(call.context.systemPrompt
        ? [{ role: 'system', content: call.context.systemPrompt }]
        : []),
      ...call.context.messages.map(chat),
    ].map((message) =>
      header && message.role === 'user' && message.content.startsWith(header)
        ? { ...message, content: '[owner context omitted]' }
        : message,
    ),
    tools: (call.context.tools ?? []).map((tool) => tool.name),
    output: chat(message),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: usage.costUsd ?? null,
    },
    ...(message.stopReason === 'error' || message.stopReason === 'aborted'
      ? { error: message.errorMessage || message.stopReason }
      : {}),
    metadata: { ...metadata, stop_reason: message.stopReason },
  };
}
