import type { Agent, ModelUsageObservation, RuntimeObservation } from '../../src/ports/agent.ts';

export type Observation = RuntimeObservation | ModelUsageObservation;

function redactedInput(name: string, input: unknown) {
  const action = (input as { action?: unknown } | null)?.action;
  if (name === 'manage_personal_context' && String(action).startsWith('memory_'))
    return { action, args: '[private memory omitted]' };
  if (!input || typeof input !== 'object') return input;
  if (name === 'browser' && ['fill', 'type', 'accept_dialog'].includes(String(action)))
    return { ...input, text: '[redacted]' };
  return input;
}

export function createCapture() {
  const observations: Array<{ turnId: string; event: Observation }> = [];
  const prompts: Array<{ turnId: string; instruction: string }> = [];
  const privateOutputs = new Set<string>();
  const opened = new Set<string>();
  return {
    observations,
    prompts,
    observe(turnId: string, event: Observation) {
      if (event.type === 'model_usage') return;
      if (event.type === 'tool_start') {
        if (
          event.name === 'sign_in' ||
          (event.name === 'manage_personal_context' &&
            String((event.input as { action?: unknown } | null)?.action).startsWith('memory_'))
        )
          privateOutputs.add(event.id);
        observations.push({
          turnId,
          event: { ...event, input: redactedInput(event.name, event.input) },
        });
        return;
      }
      if (event.status === 'succeeded' && privateOutputs.has(event.id)) {
        const { output: _output, ...rest } = event;
        observations.push({ turnId, event: rest });
      } else observations.push({ turnId, event });
    },
    agent(base: Agent): Agent {
      return {
        open: async (options) => {
          const main = !opened.has(options.turnId);
          opened.add(options.turnId);
          const record = (instruction: string) => {
            if (main) prompts.push({ turnId: options.turnId, instruction });
            return instruction;
          };
          const { nextMessages } = options;
          const session = await base.open({
            ...options,
            onEvent: (event) => {
              if (event.type === 'model_usage')
                observations.push({ turnId: options.turnId, event });
              options.onEvent(event);
            },
            ...(nextMessages
              ? {
                  nextMessages: async () =>
                    (await nextMessages()).map((message) => ({
                      ...message,
                      text: record(message.text),
                    })),
                }
              : {}),
          });
          return { ...session, prompt: (text, images) => session.prompt(record(text), images) };
        },
        dispose: () => base.dispose(),
      };
    },
  };
}
