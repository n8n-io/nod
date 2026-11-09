import { randomUUID } from 'node:crypto';
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { ModelTrace } from '../../ports/traces.ts';
import { piUsageMetrics } from './usage.ts';
import { untrustedParts } from '../../shared/untrusted.ts';

const omitted = '[owner context omitted]';
const learnedSkill = untrustedParts('learned skill').open;
const memory = (name: string, args: Record<string, unknown> | undefined) =>
  name === 'manage_personal_context' && String(args?.action).startsWith('memory_');
const privateCall = (name: string, args?: Record<string, unknown>) =>
  name === 'codemode' || memory(name, args);

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

function chat(message: Message, hidden = new Set<string>()) {
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
            function: {
              name: call.name,
              arguments: JSON.stringify(
                hidden.has(call.id) || privateCall(call.name, call.arguments)
                  ? { action: call.arguments.action }
                  : call.arguments,
              ),
            },
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
  const calls = new Map(
    call.context.messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((block) =>
            block.type === 'toolCall' ? [[block.id, block.arguments] as const] : [],
          )
        : [],
    ),
  );
  const owned = (message: ToolResultMessage) =>
    privateCall(message.toolName, calls.get(message.toolCallId)) ||
    (message.toolName === 'skills' && text(message.content).startsWith(learnedSkill));
  const hidden = new Set(
    call.context.messages.flatMap((message) =>
      message.role === 'toolResult' && owned(message) ? [message.toolCallId] : [],
    ),
  );
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
      ...call.context.messages.map((message) =>
        message.role === 'toolResult' && hidden.has(message.toolCallId)
          ? { role: 'tool', tool_call_id: message.toolCallId, content: omitted }
          : chat(message, hidden),
      ),
    ].map((message) =>
      header && message.role === 'user' && message.content.startsWith(header)
        ? { ...message, content: omitted }
        : message,
    ),
    tools: (call.context.tools ?? []).map((tool) => tool.name),
    output: chat(
      message,
      new Set(
        message.content.flatMap((block) =>
          block.type === 'toolCall' && block.name === 'skills' && block.arguments.action === 'read'
            ? [block.id]
            : [],
        ),
      ),
    ),
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
