import { Type, type Static, type TLiteral, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { AgentToolMetadata } from '../ports/agent.ts';
import type { BrowserAction } from '../ports/computer.ts';
import { browserDownloadBytes } from '../ports/computer.ts';
import { browserUploadBytes } from '../ports/computer.ts';
import { basename } from 'node:path';
import { isMessageReaction } from '../shared/emoji.ts';
import { integrationDownloadActions } from '../shared/integrations.ts';
import { requestsPrivateInput, vaultInvitation } from './communication.ts';
import { browserFlowParameters } from './browser-flows.ts';
import { privateInputNotice, type Turn } from './turn.ts';

export const personalActions = [
  'profile_get',
  'profile_update',
  'profile_learn',
  'notification_preferences_get',
  'notification_preferences_update',
  'history_search',
  'memory_list',
  'memory_save',
  'memory_forget',
  'schedule_list',
  'schedule_create',
  'schedule_update',
  'schedule_cancel',
  'schedule_record_observation',
  'goal_list',
  'goal_create',
  'goal_update',
] as const;

const uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});

function literals<const T extends readonly string[]>(values: T) {
  return Type.Union(values.map((value) => Type.Literal(value)) as TLiteral<T[number]>[]);
}

function defineTool<const N extends string, P extends TSchema>(
  name: N,
  description: string,
  parameters: P,
) {
  return { name, description, parameters };
}

export const scheduleObservation = Type.Union([
  Type.Object(
    {
      status: Type.Literal('verified'),
      sourceUrl: Type.String(),
      value: Type.String({ maxLength: 300 }),
      summary: Type.String({ maxLength: 500 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal('unavailable'),
      sourceUrl: Type.String(),
      value: Type.Null(),
      summary: Type.String({ maxLength: 500 }),
    },
    { additionalProperties: false },
  ),
]);

const activityCheckTool = defineTool(
  'record_activity_check',
  'Record this read-only activity check once. verified requires a successful read from the selected account; include at most one useful finding with its stable source ID. Use unavailable when the source could not be inspected. This does not notify the user or prepare work.',
  Type.Union([
    Type.Object(
      {
        status: Type.Literal('verified'),
        value: Type.String({ minLength: 1, maxLength: 300 }),
        summary: Type.String({ minLength: 1, maxLength: 500 }),
        finding: Type.Optional(
          Type.Object(
            {
              id: Type.String({ minLength: 1, maxLength: 300 }),
              version: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
              url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
              summary: Type.String({ minLength: 1, maxLength: 500 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        status: Type.Literal('unavailable'),
        summary: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ]),
);

export const toolDefinitions = {
  send_message: defineTool(
    'send_message',
    'Send a message to the user now: the acknowledgement before work, a real update, or an earlier short message of your reply. Do not repeat it in the final answer. In background runs, send only useful results or necessary questions.',
    Type.Object({
      text: Type.String(),
      replyToMessageId: Type.Optional(Type.String({ pattern: '^[0-9a-fA-F-]{36}$' })),
    }),
  ),
  ask_user: defineTool(
    'ask_user',
    'Ask one necessary question and pause until the user answers.',
    Type.Object({ question: Type.String() }),
  ),
  react_to_message: defineTool(
    'react_to_message',
    'Occasionally react to a user message with one emoji (web only, one per message, five-minute cooldown). null removes it. Never a substitute for an answer or permission.',
    Type.Object({
      messageId: Type.String({ pattern: '^[0-9a-fA-F-]{36}$' }),
      reaction: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    }),
  ),
  browser: defineTool(
    'browser',
    'Control your private agent-browser session. open {url}; snapshot (text, controls, scrollable areas; selector/offset/controlOffset page through more); click {selector}; fill {selector, text} (never secrets); select {selector, text} by visible label or value; check/uncheck/hover {selector}; drag {selector, targetSelector}; upload {selector, path} from the task workspace; back/forward/reload; tab_list and tab_switch {tabId}; press {key}; scroll {direction, selector?}; screenshot (image for you); share_screenshot {name?} (send the image to the user); download {url? | selector?, name?} (copy a file into the workspace; foreground downloads also deliver it, while background downloads stay private until share_file; with neither, the open PDF or the last download). waitMs (up to 15000) waits for slow pages.',
    Type.Object({
      action: literals([
        'open',
        'snapshot',
        'click',
        'fill',
        'press',
        'scroll',
        'select',
        'check',
        'uncheck',
        'hover',
        'drag',
        'upload',
        'back',
        'forward',
        'reload',
        'tab_list',
        'tab_switch',
        'screenshot',
        'share_screenshot',
        'download',
      ]),
      url: Type.Optional(Type.String({ maxLength: 8192 })),
      tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      selector: Type.Optional(Type.String()),
      targetSelector: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      text: Type.Optional(Type.String({ maxLength: 8000 })),
      key: Type.Optional(
        literals(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']),
      ),
      direction: Type.Optional(literals(['up', 'down'])),
      waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 15000 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
      controlOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
  ),
  browser_flow: defineTool(
    'browser_flow',
    'Reuse known website routines in the current private browser. list {query?} reads the flow registry and ranks matches. get {id} shows a flow. save {flow} stores a checked flow as a file. run {id, inputs?} replays it and checks expectText or expectUrl after each step. It stops with the current page if a check fails. Files live in the owner flow library and remain available after a conversation reset. Start with open and end with a checked snapshot. Use stable selectors and named inputs for entered text. Never store passwords or codes.',
    browserFlowParameters,
  ),
  get_credential: defineTool(
    'get_credential',
    'Get a saved website login from Vault by its ID and exact origin. The result includes the username and password. To fill protected browser fields, omit the ID and give field references from a fresh browser snapshot. Pass savedLoginId to select one applicable login. For OTP, set emailCode:true only when the page says it sent a code by email. Vault can fill a saved login or open a secure form. Submit with browser and inspect the result.',
    Type.Union([
      Type.Object({
        id: uuid,
        origin: Type.String({ minLength: 1, maxLength: 2048 }),
      }),
      Type.Object({
        origin: Type.String({ minLength: 1, maxLength: 2048 }),
        label: Type.String({ minLength: 1, maxLength: 100 }),
        kind: literals(['identifier', 'password', 'otp']),
        usernameSelector: Type.Optional(Type.String()),
        passwordSelector: Type.Optional(Type.String()),
        emailCode: Type.Optional(Type.Boolean()),
        savedLoginId: Type.Optional(uuid),
      }),
    ]),
  ),
  browser_session: defineTool(
    'browser_session',
    'Browser profiles for website accounts. connect opens a new private profile; use opens an existing profile without verifying sign-in. Inspect the current page to determine the outcome. save with signedIn:true records that you observed a successful sign-in on this origin.',
    Type.Union([
      Type.Object({
        action: Type.Literal('connect'),
        url: Type.String({ minLength: 1, maxLength: 2048 }),
        label: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      }),
      Type.Object({
        action: Type.Literal('use'),
        url: Type.String({ minLength: 1, maxLength: 2048 }),
        connectionId: uuid,
      }),
      Type.Object({
        action: Type.Literal('save'),
        url: Type.String({ minLength: 1, maxLength: 2048 }),
        connectionId: uuid,
        signedIn: Type.Literal(true),
      }),
    ]),
  ),
  apps: defineTool(
    'apps',
    "Use the user's connected accounts. SEARCH_TOOLS {query} returns exact actions, schemas, account and path IDs. Other actions run with args; download actions copy files into the workspace. Foreground downloads also deliver them; background downloads stay private until share_file. Writes may pause for confirmation.",
    Type.Object({
      action: Type.String({ maxLength: 150 }),
      args: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
  manage_apps: defineTool(
    'manage_apps',
    'list saved accounts and access paths: savedLogin:true marks Vault logins for their exact access-path origin; browserAccess:browser_session marks private browser profiles. Neither exposes credentials. connect {service} starts a native sign-in and pauses; propose {service, proposal} saves a new MCP, HTTP or CLI path and gives the user a private setup link.',
    Type.Object({
      action: literals(['list', 'connect', 'propose']),
      service: Type.Optional(Type.String({ maxLength: 80 })),
      proposal: Type.Optional(
        Type.Object({
          service: Type.String({ maxLength: 40 }),
          name: Type.String({ maxLength: 80 }),
          connectionId: Type.Optional(Type.String()),
          setupUrl: Type.Optional(Type.String({ maxLength: 2048 })),
          setupText: Type.Optional(Type.String({ maxLength: 500 })),
          paths: Type.Array(
            Type.Union([
              Type.Object({
                kind: Type.Literal('http'),
                endpoint: Type.String({ maxLength: 2048 }),
                auth: Type.Optional(literals(['bearer', 'x-api-key'])),
                testPath: Type.String({ minLength: 1, maxLength: 500 }),
              }),
              Type.Object({
                kind: Type.Literal('mcp'),
                endpoint: Type.String({ maxLength: 2048 }),
                auth: Type.Optional(literals(['bearer', 'x-api-key', 'oauth'])),
                scope: Type.Optional(Type.String({ maxLength: 500 })),
                clientIdRequired: Type.Optional(Type.Boolean()),
              }),
              Type.Object({
                kind: Type.Literal('cli'),
                command: Type.String({ minLength: 1, maxLength: 64 }),
                auth: Type.Optional(Type.Literal('env')),
                envName: Type.String({ minLength: 3, maxLength: 80 }),
                testArgs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
                  minItems: 1,
                  maxItems: 12,
                }),
              }),
            ]),
            { minItems: 1, maxItems: 4 },
          ),
        }),
      ),
    }),
  ),
  manage_personal_context: defineTool(
    'manage_personal_context',
    "The user's profile, goals, schedules, notification preferences, memory and earlier conversation. memory_list {}, memory_save {kind:'fact'|'preference'|'pattern', text, id?, replace?}, memory_forget {id}. A memory write uses the current owned user message as evidence and is shown in chat; do not repeat it. Reuse an entry ID to add evidence; use replace:true for a correction. Save lasting user facts and repeated patterns, never a guess or a website claim. schedule_create {title, prompt, timeZone, kind:'once', runAt} or {kind:'recurring', cron}; schedule_record_observation {status, sourceUrl, value, summary} saves a checked value for the current scheduled run and returns the previous one; profile_learn {field, value, quote}; history_search {query}.",
    Type.Object({
      action: literals(personalActions),
      args: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
  share_file: defineTool(
    'share_file',
    'Send a workspace file to the user as an attachment. Check the file first; a successful call already delivers it.',
    Type.Object({
      path: Type.String(),
      name: Type.Optional(Type.String({ maxLength: 200 })),
    }),
  ),
  create_audio: defineTool(
    'create_audio',
    'Turn text into speech and send the audio to the user.',
    Type.Object({ text: Type.String({ minLength: 1, maxLength: 3000 }) }),
  ),
};

export interface OttoTool<P extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: P;
  execute(params: Static<P>): Promise<unknown>;
}

function bind<P extends TSchema>(
  definition: { name: string; description: string; parameters: P },
  execute: (params: Static<P>) => Promise<unknown>,
): OttoTool {
  return { ...definition, execute } as OttoTool;
}

export function ottoTools(
  turn: Turn,
  browserFlows: (params: Static<typeof browserFlowParameters>) => Promise<unknown>,
): OttoTool[] {
  const { context, computer, pause, confirm } = turn;
  const { threadId, signal } = context;
  const screenshot = async () => {
    const bytes = await computer.screenshot(threadId, signal);
    signal.throwIfAborted();
    return bytes;
  };
  const link = async (url: unknown, text: (url: string) => string) => {
    if (typeof url !== 'string') throw new Error('The sign-in link is unavailable.');
    await pause('question', text(url));
    return 'Waiting for the user to sign in.';
  };
  const tools = [
    bind(
      toolDefinitions.send_message,
      async (p) =>
        (await turn.reply(p.text, undefined, p.replyToMessageId)) ?? 'Message delivered.',
    ),
    bind(toolDefinitions.ask_user, async (p) => {
      if (requestsPrivateInput(p.question))
        return { status: 'withheld', message: privateInputNotice };
      const text = p.question.trim();
      if (!text) throw new Error('A question is required.');
      await pause('question', text, { hold: true });
      return 'Waiting for the user to reply.';
    }),
    bind(toolDefinitions.react_to_message, async (p) => {
      if (p.reaction !== null && !isMessageReaction(p.reaction))
        throw new Error('Choose one emoji reaction.');
      if (
        context.background ||
        (context.channel && context.channel !== 'web') ||
        !context.reactToMessage
      )
        return {
          status: 'skipped',
          reason: 'unavailable',
          message: 'Reactions are only available in the web conversation.',
        };
      return context.reactToMessage(p.messageId, p.reaction);
    }),
    bind(toolDefinitions.browser, async ({ action, name, ...rest }) => {
      if (action === 'screenshot') {
        const bytes = await screenshot();
        if (!bytes) return 'Open a browser URL first.';
        return {
          content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
          details: {},
        };
      }
      if (action === 'share_screenshot') {
        if (!context.publishScreenshot) throw new Error('Screenshot publishing is unavailable.');
        const bytes = await screenshot();
        if (!bytes) throw new Error('The browser does not have an available screenshot.');
        return context.publishScreenshot(bytes, name);
      }
      if (action === 'download') {
        if (!computer.download || !context.publishBrowserFile)
          throw new Error('Browser file delivery is unavailable.');
        const file = await computer.download(
          threadId,
          { selector: rest.selector, url: rest.url, name },
          signal,
        );
        signal.throwIfAborted();
        if (!file.bytes.length || file.bytes.length > browserDownloadBytes)
          throw new Error('Browser file delivery exceeds the download limit.');
        return context.publishBrowserFile(file);
      }
      if (action === 'upload') {
        if (!computer.upload || !context.readWorkspaceFile)
          throw new Error('Browser file upload is unavailable.');
        if (!rest.selector || !rest.path) throw new Error('Choose a file and upload field.');
        const bytes = await context.readWorkspaceFile(rest.path, browserUploadBytes);
        return computer.upload(
          threadId,
          { selector: rest.selector, name: basename(rest.path), bytes },
          signal,
        );
      }
      return computer.act(threadId, { action, ...rest } as BrowserAction, signal);
    }),
    bind(toolDefinitions.browser_flow, browserFlows),
    bind(toolDefinitions.get_credential, async (input) => {
      const result = await context.requestCredential(input);
      if (result.credential) return result.credential;
      if (!('kind' in input)) throw new Error('This saved login is unavailable.');
      if (result.filled) return 'Saved login entered.';
      if (!result.url) throw new Error('The secure sign-in request could not be created.');
      await turn.reply(vaultInvitation(result.invitation ?? input, result.url));
      await pause('credentials', undefined, { post: false });
      return 'Waiting for secure input.';
    }),
    bind(toolDefinitions.browser_session, async (p) => {
      if (!context.browserConnection) throw new Error('Browser connections are unavailable.');
      const result = (await context.browserConnection(p)) as Record<string, unknown>;
      if (p.action === 'connect' || result.status === 'needs_sign_in') {
        const { url: _url, ...safe } = result;
        return safe;
      }
      return result;
    }),
    bind(toolDefinitions.apps, async (p) => {
      if (!(integrationDownloadActions as readonly string[]).includes(p.action)) {
        const result = await context.integration(p.action, p.args, signal);
        signal.throwIfAborted();
        return context.activityCheck ? result : confirm(result);
      }
      if (!context.downloadIntegrationFile) throw new Error('App file delivery is unavailable.');
      return context.downloadIntegrationFile(p.action, p.args);
    }),
    bind(toolDefinitions.manage_apps, async (p) => {
      if (!context.connections) throw new Error('Apps are unavailable.');
      const result = await context.connections(p.action, p.service, p.proposal);
      if (p.action === 'list') return result;
      const { name, url } = result as { name?: unknown; url?: unknown };
      if (typeof name !== 'string') throw new Error('The app did not provide a sign-in link.');
      return link(
        url,
        (url) =>
          `I need access to your ${name} account for this task. [Connect ${name}](${url}) and I will continue here.`,
      );
    }),
    bind(toolDefinitions.manage_personal_context, async (p) => {
      if (p.action !== 'schedule_record_observation')
        return confirm(await context.manage(p.action, p.args));
      if (!Value.Check(scheduleObservation, p.args))
        return 'schedule_record_observation needs {status, sourceUrl, value, summary}; value is null when unavailable.';
      return context.manage(p.action, p.args);
    }),
    bind(toolDefinitions.share_file, (p) => context.publish(p.path, p.name)),
    bind(toolDefinitions.create_audio, async (p) => {
      if (!context.createAudio)
        throw new Error('Audio generation is not available in this runtime.');
      return context.createAudio(p.text);
    }),
  ];
  if (context.activityCheck) {
    const check = context.activityCheck;
    return [
      ...tools.filter((tool) => tool.name === 'apps'),
      bind(activityCheckTool, async (result) => {
        signal.throwIfAborted();
        await check.record(result, signal);
        return 'Activity check recorded.';
      }),
    ];
  }
  return tools;
}

export function inspectToolCatalog(): AgentToolMetadata[] {
  return Object.values(toolDefinitions).map((tool) => structuredClone(tool));
}
