import { randomUUID } from 'node:crypto';
import {
  getSystemMessageText,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Tool,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { ModelFailure } from '../../ports/agent.ts';
import type { ModelCallTrace, ModelTrace, ModelTraces } from '../../ports/traces.ts';
import { piUsageMetrics } from './usage.ts';
import { memoryEvidenceSource, untrustedParts } from '../../shared/untrusted.ts';
import { modelQuotaFailure } from '../../shared/model-quota.ts';

const omitted = '[owner context omitted]';
const memoryEvidence = new RegExp(
  `<untrusted_tool_result source=\\\\?"${memoryEvidenceSource}\\\\?">[\\s\\S]*?</untrusted_tool_result>`,
  'g',
);
const learnedSkill = untrustedParts('learned skill').open;
const memory = (name: string, args: Record<string, unknown> | undefined) =>
  (name === 'memory' || name === 'manage_personal_context') &&
  String(args?.action).startsWith('memory_');
const privateCall = (name: string, args?: Record<string, unknown>) =>
  name === 'codemode' || memory(name, args);

export interface ModelRequestFacts {
  requestPhase: 'prepare' | 'payload' | 'request' | 'response' | 'stream';
  requestKind: 'regular' | 'cache_warm';
}

export interface PiModelCall {
  request?: ModelRequestFacts;
  model: Model<Api>;
  context: Context;
  message: AssistantMessage;
  startedAt: string;
}

function errorType(error: string, phase?: ModelRequestFacts['requestPhase']) {
  const status =
    [...error.matchAll(/\bHTTP\s+([1-5]\d{2})\b/gi)].at(-1)?.[1] ??
    /^\s*([1-5]\d{2})\b/.exec(error)?.[1];
  if (status === '401') return 'auth';
  if (status === '402') return 'billing';
  if (status === '503') return 'provider_unavailable';
  const quota = modelQuotaFailure(error);
  if (
    (phase === 'prepare' || phase === 'payload') &&
    /(?:model|pricing|cost|price|api key|connection).*(?:no cost|no price|unavailable|not configured|missing|unknown)|(?:no cost|no price|unknown price)/i.test(
      error,
    )
  )
    return 'model_config';
  if (
    /authentication_error|invalid_api_key|\bunauthori[sz]ed\b|(?:api[_ -]?key|(?:authentication|access|refresh)[_ -]token).*(?:invalid|not valid|expired)|(?:invalid|incorrect|expired).*(?:api[_ -]?key|(?:authentication|access|refresh)[_ -]token)/i.test(
      error,
    )
  )
    return 'auth';
  if (quota?.kind === 'credits_depleted') return 'billing';
  if (quota) return 'quota';
  if (
    /positive balance|insufficient[_ -](?:credits?|funds|balance)|credit balance.*(?:low|exhausted|insufficient)|billing[_ -](?:hard[_ -]limit[_ -](?:reached|exceeded)|not[_ -]active)|billing (?:is )?(?:disabled|inactive)|payment required|requires more credits|(?:exhausted|insufficient|out of|not enough).*(?:credits?|funds)/i.test(
      error,
    )
  )
    return 'billing';
  if (
    /insufficient_quota/i.test(error) ||
    (/free[_ -]?tier|daily|per[_ -]?day/i.test(error) && /quota|limit|allowance/i.test(error))
  )
    return 'quota';
  if (/rate[_ -]?limit|too many requests|requests per minute|tokens per minute/i.test(error))
    return 'rate_limit';
  if (/usage[_ -]limit|subscription.*limit.*(?:reached|exceeded)/i.test(error)) return 'quota';
  if (
    /high demand|overloaded_error|\b(?:model|service).*(?:overloaded|temporarily unavailable)|\bservice unavailable\b/i.test(
      error,
    )
  )
    return 'provider_unavailable';
  if (/quota.*(?:exceeded|exhausted)|(?:exceeded|exhausted).*quota/i.test(error)) return 'quota';
  if (/\b429\b/.test(error)) return 'rate_limit';
  const terminated =
    /^(?:(?:Type)?Error:\s*)?terminated(?:\s+\(HTTP [1-5]\d{2}\))?(?:\s+\(transport cause: [A-Z_]+\))?(?:\s+\[request phase: [a-z_]+\])?\s*$/i.test(
      error,
    ) ||
    /\b(?:stream|socket|connection)(?: (?:was|has been|is|unexpectedly))? terminated\b|\bterminated (?:response )?(?:stream|socket|connection)\b/i.test(
      error,
    );
  if (
    terminated ||
    /\b(?:ECONN[A-Z]+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_[A-Z_]+)\b|fetch failed|failed to fetch|network|connection (?:error|failed|refused|reset)|timed? ?out|timeout/i.test(
      error,
    )
  )
    return 'connection';
  return 'unknown';
}

const toolsUnsupported =
  /\b(?:tools?|tool[_ -]?(?:use|calls?|calling|choice)|function[_ -]?call(?:s|ing)?)\b.{0,80}?\b(?:(?:not|n't) (?:supported|enabled|available)|unsupported|requires --enable-auto-tool-choice)|\b(?:not|n't) support\b.{0,40}?\b(?:tools?|tool[_ -]?(?:use|calls?|calling)|function[_ -]?calling)\b|\bno endpoints found that support tool/i;
const failureKinds: Record<string, ModelFailure['kind']> = {
  auth: 'authentication',
  billing: 'quota_exhausted',
  quota: 'quota_exhausted',
  rate_limit: 'rate_limited',
  provider_unavailable: 'unavailable',
  model_config: 'invalid_request',
};

export function modelFailure(error: string, overflow = false): ModelFailure {
  const status = Number([...error.matchAll(/\(HTTP ([1-5]\d{2})\)/g)].at(-1)?.[1]) || undefined;
  const phase = /\[request phase: ([a-z_]+)\]\s*$/.exec(error)?.[1];
  const type = errorType(error, phase as ModelRequestFacts['requestPhase'] | undefined);
  const kind =
    overflow || status === 413 || /\brequest too large\b/i.test(error)
      ? 'context_too_large'
      : toolsUnsupported.test(error)
        ? 'tools_unsupported'
        : type === 'connection'
          ? /timed? ?out|timeout/i.test(error)
            ? 'timeout'
            : 'unavailable'
          : (failureKinds[type] ??
            (status === 403
              ? 'permission'
              : status === 408 || status === 504
                ? 'timeout'
                : status && status >= 500
                  ? 'unavailable'
                  : status && status >= 400
                    ? 'invalid_request'
                    : 'unknown'));
  return { kind, ...(status ? { status } : {}) };
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
  const error =
    message.stopReason === 'error' || message.stopReason === 'aborted'
      ? message.errorMessage || message.stopReason
      : undefined;
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
        : message.role === 'user'
          ? { ...message, content: message.content.replace(memoryEvidence, '[memory omitted]') }
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
    ...(error ? { error } : {}),
    metadata: {
      ...metadata,
      stop_reason: message.stopReason,
      ...(error
        ? {
            error_type:
              message.stopReason === 'aborted'
                ? 'aborted'
                : errorType(error, call.request?.requestPhase),
          }
        : {}),
      ...(call.request
        ? {
            request_phase: call.request.requestPhase,
            request_kind: call.request.requestKind,
          }
        : {}),
    },
  };
}

function withoutImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImageData);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  if ((value as { type?: unknown }).type === 'image')
    return Object.fromEntries(
      entries.map(([key, item]) =>
        key === 'data' && typeof item === 'string'
          ? [key, `[${item.length} base64 characters]`]
          : [key, item],
      ),
    );
  return Object.fromEntries(entries.map(([key, item]) => [key, withoutImageData(item)]));
}

function replayedSystem(context: Context) {
  const tools = new Map<string, Tool>((context.tools ?? []).map((tool) => [tool.name, tool]));
  const content: string[] = context.systemPrompt ? [context.systemPrompt] : [];
  const sections: Record<string, string | null> = {};
  for (const entry of context.messages) {
    if (entry.role !== 'system') continue;
    const text = getSystemMessageText({ ...entry, sections: undefined });
    if (text) content.push(text);
    Object.assign(sections, entry.sections);
    for (const tool of entry.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const tool of entry.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return {
    systemPrompt: getSystemMessageText({
      role: 'system',
      content: content.join('\n\n'),
      sections: Object.fromEntries(Object.entries(sections).filter(([, value]) => value !== null)),
      timestamp: 0,
    }),
    tools: [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
}

export function piModelCallTrace(
  call: PiModelCall,
  metadata: {
    source: string;
    task?: string;
    turnId?: string;
    runId?: string;
    parentRunId?: string;
    endedAt?: string;
  },
): ModelCallTrace {
  const { message } = call;
  const usage = piUsageMetrics(message.usage);
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const inputTokens = (usage.inputTokens ?? 0) + cacheReadTokens + cacheWriteTokens;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    id: randomUUID(),
    ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value)),
    source: metadata.source,
    provider: call.model.provider,
    model: message.responseModel ?? call.model.id,
    startedAt: call.startedAt,
    endedAt: metadata.endedAt ?? new Date().toISOString(),
    ...replayedSystem(call.context),
    messages: withoutImageData(
      call.context.messages.map((entry) =>
        entry.role === 'system'
          ? {
              role: 'system',
              content: `[${getSystemMessageText({ ...entry, sections: Object.fromEntries(Object.entries(entry.sections ?? {}).filter(([, value]) => value !== null)) }).length} characters, shown in the system prompt]`,
              timestamp: entry.timestamp,
              ...(entry.toolsAdded
                ? { toolsAdded: entry.toolsAdded.map((tool) => tool.name) }
                : {}),
              ...(entry.toolsRemoved
                ? { toolsRemoved: entry.toolsRemoved.map((tool) => tool.name) }
                : {}),
            }
          : entry,
      ),
    ) as unknown[],
    output: withoutImageData({ content: message.content, stopReason: message.stopReason }),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: usage.costUsd ?? null,
    },
    stopReason: message.stopReason,
    ...(call.request ? { requestKind: call.request.requestKind } : {}),
    ...(message.stopReason === 'error' || message.stopReason === 'aborted'
      ? { error: message.errorMessage || message.stopReason }
      : {}),
  };
}

export function recordPiModelCall(
  traces: ModelTraces | undefined,
  call: PiModelCall,
  trace: () => ModelTrace,
  metadata: Parameters<typeof piModelCallTrace>[1],
) {
  if (!traces) return;
  if (traces.active()) traces.record(trace());
  capturePiModelCall(traces, call, metadata);
}

export function capturePiModelCall(
  traces: ModelTraces | undefined,
  call: PiModelCall,
  metadata: Parameters<typeof piModelCallTrace>[1],
) {
  if (!traces?.capturing?.()) return;
  const snapshot = { ...call, context: { ...call.context, messages: [...call.context.messages] } };
  const endedAt = new Date().toISOString();
  traces.capture?.(() => piModelCallTrace(snapshot, { ...metadata, endedAt }), metadata.turnId);
}
