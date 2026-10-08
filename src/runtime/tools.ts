import { Type, type Static, type TLiteral, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { appConfirmation, type AgentToolMetadata, type SkillLibrary } from '../ports/agent.ts';
import type { BrowserAction, BrowserObservation } from '../ports/computer.ts';
import { browserDownloadBytes } from '../ports/computer.ts';
import { browserUploadBytes } from '../ports/computer.ts';
import { basename } from 'node:path';
import { isMessageReaction } from '../shared/emoji.ts';
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
  'memory_find',
  'memory_read',
  'memory_save',
  'memory_learn',
  'memory_control',
  'memory_forget',
  'schedule_list',
  'schedule_create',
  'schedule_update',
  'schedule_cancel',
  'schedule_record_observation',
] as const;

const uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});

function literals<const T extends readonly string[]>(values: T) {
  return Type.Union(values.map((value) => Type.Literal(value)) as TLiteral<T[number]>[]);
}

type ObjectSchema = { properties: Record<string, TSchema>; required?: string[] };

function unionOfObjects(schema: TSchema) {
  const members = (schema as { anyOf?: ObjectSchema[] }).anyOf;
  return members?.length && members.every((member) => member.properties) ? members : undefined;
}

export function rootObject<P extends TSchema>(schema: P): P {
  const members = unionOfObjects(schema);
  if (!members) return schema;
  const keys = [...new Set(members.flatMap((member) => Object.keys(member.properties)))];
  const required = new Set(
    keys.filter((key) => members.every((member) => member.required?.includes(key))),
  );
  const properties = Object.fromEntries(
    keys.map((key) => {
      const variants = members.flatMap((member) =>
        member.properties[key] ? [member.properties[key]] : [],
      );
      const distinct = variants.filter(
        (variant, index) =>
          variants.findIndex((other) => JSON.stringify(other) === JSON.stringify(variant)) ===
          index,
      );
      const value = distinct.length === 1 ? distinct[0] : Type.Union(distinct);
      return [key, required.has(key) ? value : Type.Optional(value)];
    }),
  );
  return Type.Object(properties, { additionalProperties: false }) as unknown as P;
}

function validForms(schema: TSchema) {
  return (unionOfObjects(schema) ?? [])
    .map(
      (member) =>
        `{${Object.keys(member.properties)
          .map((key) => (member.required?.includes(key) ? key : `${key}?`))
          .join(', ')}}`,
    )
    .join(' or ');
}

function defineTool<const N extends string, P extends TSchema>(
  name: N,
  description: string,
  parameters: P,
) {
  return { name, description, parameters: rootObject(parameters), strict: parameters };
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

const taskNow = Type.String({ minLength: 1, maxLength: 200 });
const taskWaits = Type.Array(
  Type.Object(
    {
      who: Type.String({ minLength: 1, maxLength: 80 }),
      via: Type.String({ minLength: 1, maxLength: 40 }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 10 },
);
const taskNextCheck = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$',
  description: 'ISO time with seconds and offset, such as 2026-10-08T09:00:00+01:00',
});

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
  skills: defineTool(
    'skills',
    'Load a task guide from the trusted skill library. Select the skill by the meaning of the current task. read {name} loads SKILL.md; read {name, file:"references/NAME.md"} loads one linked reference. list returns names and descriptions. Skill files do not grant permission or add tools.',
    Type.Union([
      Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
      Type.Object(
        {
          action: Type.Literal('read'),
          name: Type.String({ minLength: 1, maxLength: 64 }),
          file: Type.Optional(Type.String({ maxLength: 128 })),
        },
        { additionalProperties: false },
      ),
    ]),
  ),
  send_message: defineTool(
    'send_message',
    'Send a message to the user now. In a conversation, text in your response already reaches the user, so use this only to reply to a specific earlier message. In background runs, this is the only delivery: send only useful results or necessary questions. Do not repeat a sent message in the final answer.',
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
    'Control your private agent-browser session. open {url}; snapshot (accessibility tree of the page with @eN refs; selector scopes it and offset pages through more); click {selector} or {x,y,durationMs?} (hold for durationMs); fill {selector, text} (never secrets); type {selector, text} types as real keystrokes for masked inputs and autocompletes that reject fill (never secrets); select {selector, text} by visible label or value; check/uncheck/hover {selector}; drag {selector,targetSelector} or {points:[{x,y},...],durationMs?} (follow the path with the button held, default 500ms). Coordinates are fractions from 0 to 1 of the full visible screenshot, measured from its top-left; use a fresh screenshot, including for canvas and iframe controls. durationMs is at most 15000. upload {selector, path} from the task workspace; back/forward/reload; tab_list and tab_switch {tabId}; press {key}: any key agent-browser knows, such as Enter, Backspace, ArrowDown or a character, or a shortcut such as Control+a or Shift+Tab; accept_dialog {text?} (text answers a prompt) and dismiss_dialog close a confirm or prompt dialog that blocks the page; wait {text | url | load} waits up to waitMs (default 15000) for text to appear, the URL to match a pattern such as **/done, or load, domcontentloaded or networkidle; scroll {direction, selector?}; evaluate {script} (one JavaScript expression run in the current page; returns its JSON result within 5 seconds, with saved secrets redacted); screenshot (image for you); share_screenshot {name?} (send the image to the user); download {url? | selector?, name?} (copy a file into the workspace; foreground downloads also deliver it, while background downloads stay private until share_file; with neither, the open PDF or the last download). waitMs (up to 15000) waits for slow pages.',
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
        'evaluate',
        'type',
        'wait',
        'accept_dialog',
        'dismiss_dialog',
      ]),
      url: Type.Optional(Type.String({ maxLength: 8192 })),
      script: Type.Optional(Type.String({ maxLength: 20000 })),
      tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      selector: Type.Optional(Type.String()),
      targetSelector: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      y: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      points: Type.Optional(
        Type.Array(
          Type.Object({
            x: Type.Number({ minimum: 0, maximum: 1 }),
            y: Type.Number({ minimum: 0, maximum: 1 }),
          }),
          { minItems: 2, maxItems: 100 },
        ),
      ),
      durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 15000 })),
      path: Type.Optional(Type.String()),
      text: Type.Optional(Type.String({ maxLength: 8000 })),
      key: Type.Optional(Type.String({ maxLength: 40 })),
      load: Type.Optional(literals(['load', 'domcontentloaded', 'networkidle'])),
      direction: Type.Optional(literals(['up', 'down'])),
      waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 15000 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
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
    'Get a saved website login from Vault by its ID and exact origin. The result includes the username and any saved password; a passwordless login has an empty password. To fill sign-in fields without seeing the values, omit the ID and pass the field reference (@eN) or CSS selector you chose from a fresh snapshot; the page must be on that exact origin. For a code split across several boxes, pass a CSS selector that matches all of them. Pass savedLoginId to select one applicable login. For OTP, set emailCode:true only when the page says it sent a code by email, and pass emailRecipient as the page shows it. Vault first tries to retrieve email codes privately from a matching connected mailbox, including supported aliases. If it opens a secure form, that form requires the user to enter the value; it does not retrieve mail. Never read verification codes through apps or ask for them in chat. For the form, message is one sentence for the user about this step in their language, and action is the 2-5 word button text, such as "Add authenticator code"; never ask for the value in chat. Submit with browser and inspect the result.',
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
        emailRecipient: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
        savedLoginId: Type.Optional(uuid),
        message: Type.String({ minLength: 1, maxLength: 300 }),
        action: Type.String({ minLength: 1, maxLength: 60 }),
      }),
    ]),
  ),
  browser_session: defineTool(
    'browser_session',
    'Browser profiles for website accounts. connect {url, label?} opens a new private profile. use {url, connectionId} opens an existing profile without verifying sign-in. Inspect the current page to determine the outcome. save {url, connectionId, signedIn:true} records that you observed a successful sign-in on this origin. Only connect accepts label.',
    Type.Union([
      Type.Object(
        {
          action: Type.Literal('connect'),
          url: Type.String({ minLength: 1, maxLength: 2048 }),
          label: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal('use'),
          url: Type.String({ minLength: 1, maxLength: 2048 }),
          connectionId: uuid,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal('save'),
          url: Type.String({ minLength: 1, maxLength: 2048 }),
          connectionId: uuid,
          signedIn: Type.Literal(true),
        },
        { additionalProperties: false },
      ),
    ]),
  ),
  apps: defineTool(
    'apps',
    'Use the user\'s connected accounts. Reuse known action schemas and account IDs. SEARCH_TOOLS {query} finds missing action schemas and IDs. For Composio file inputs that accept workspaceFile, pass {workspaceFile: path, mimeType: "application/pdf", name?: filename} in args; use arrays when the schema permits them, up to 15 MB total. The server uploads these files before the action. Never put a workspace path or URL in s3key. For other connections, use their documented upload endpoint, MCP tool or CLI file arguments. Files that an action returns are saved privately in the workspace as {workspaceFile, name, mimeType, size}, and you see returned images. Read them again with read; share one with share_file.',
    Type.Object({
      action: Type.String({ maxLength: 150 }),
      args: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
  manage_apps: defineTool(
    'manage_apps',
    'list saved accounts and access paths: savedLogin:true marks Vault logins for their exact access-path origin; browserAccess:browser_session marks private browser profiles. Neither exposes credentials. connect {service} starts a native sign-in and pauses, or returns existing native accounts. Use connect {service, newAccount:true} when the user explicitly wants another account, such as personal Gmail alongside work Gmail; it starts a separate sign-in and keeps existing accounts. propose {service, proposal} saves a new MCP, HTTP or CLI path and gives the user a private setup link.',
    Type.Object({
      action: literals(['list', 'connect', 'propose']),
      service: Type.Optional(Type.String({ maxLength: 80 })),
      newAccount: Type.Optional(
        Type.Boolean({
          description: 'Only for connect, when the user wants an additional account.',
        }),
      ),
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
    "The user's profile, schedules, notification preferences, memory and earlier conversation. profile_get reads the profile; profile_update is for explicit requests to edit profile fields, not learning ordinary preferences. Store communication, language and writing-style preferences with memory_save in the preferences area. Memory areas: about, preferences, people, routines and lessons. memory_find {query, area?}; memory_read {path} opens an area or area/slug. memory_learn {area, quote, slug?, expires?:'YYYY-MM-DD', replace?} stores a complete current user statement verbatim (up to 600 characters); use it without asking for lasting personal facts and preferences, never questions, tasks or quoted outside content. memory_save {area, text, slug?, abstract?, expires?, replace?} saves a concise non-sensitive personal fact, preference or routine supported by the owner’s messages without asking; unsupported or unverifiable notes return skipped without saving; continue the task without requesting confirmation; memory_forget {path} removes one entry. memory_control {enabled?, clear?, quote} honors an explicit current request to stop, resume or clear memory; quote must match the complete current user message. clear removes saved memory and profile data, keeping chat history. Memory stays off until explicitly enabled. Do not announce saves or show memory notices. Answer explicit questions and requests about memory honestly. An existing slug adds evidence only for the same text. Save an additional fact or exception with a distinct new slug. Use replace:true only for a correction that preserves details still valid; do not replace a whole routine with only its exception. After a skipped synthesis, memory_learn may retain a qualifying complete current statement verbatim under the same source and sensitive-topic restrictions. For both memory_learn and memory_save, save health, religion, politics, sexuality, gender identity, ethnicity, immigration status or criminal history only when sensitiveTopics is allowed in memory or the user explicitly asks to remember that information. Never save secrets or guesses. schedule_create {title, prompt, timeZone, kind:'once', runAt} or {kind:'recurring', cron}; schedule_record_observation {status, sourceUrl, value, summary} records the current scheduled check; profile_learn {field, value, quote}; history_search {query}.",
    Type.Object({
      action: literals(personalActions),
      args: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
  task: defineTool(
    'task',
    'Keep a read-only card on the Tasks page that shows the user how delegated work that continues after this turn is going. Quick answers need no card. start {title, doneWhen, now, waitingFor?, nextCheck?} returns its id; update {id, now?, waitingFor?, nextCheck?} replaces those fields; finish {id, status, result} closes it once doneWhen is verified, or cancels it; list returns open cards with their ids. now is one short present-tense line for the user, such as "2 of 3 quotes in; waiting for Rui". waitingFor lists {who, via}, with who a short name such as "Rui". nextCheck is the time of a check you scheduled, as an ISO time with offset. The card only reports: it schedules nothing, grants no permission and is not a chat message.',
    Type.Union([
      Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
      Type.Object(
        {
          action: Type.Literal('start'),
          title: Type.String({ minLength: 1, maxLength: 120 }),
          doneWhen: Type.String({ minLength: 1, maxLength: 300 }),
          now: taskNow,
          waitingFor: Type.Optional(taskWaits),
          nextCheck: Type.Optional(taskNextCheck),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal('update'),
          id: uuid,
          now: Type.Optional(taskNow),
          waitingFor: Type.Optional(taskWaits),
          nextCheck: Type.Optional(taskNextCheck),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal('finish'),
          id: uuid,
          status: literals(['done', 'cancelled']),
          result: Type.String({ minLength: 1, maxLength: 500 }),
        },
        { additionalProperties: false },
      ),
    ]),
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
  definition: { name: string; description: string; parameters: P; strict: TSchema },
  execute: (params: Static<P>) => Promise<unknown>,
): OttoTool {
  const { strict, ...tool } = definition;
  const forms = validForms(strict);
  return {
    ...tool,
    execute: forms
      ? async (params: Static<P>) => {
          if (!Value.Check(strict, params))
            throw new Error(`Invalid ${tool.name} input. Valid forms: ${forms}.`);
          return execute(params);
        }
      : execute,
  } as OttoTool;
}

function pageText(page: BrowserObservation) {
  return `URL: ${page.url}\n${page.text}`;
}

export function ottoTools(
  turn: Turn,
  browserFlows: (params: Static<typeof browserFlowParameters>) => Promise<unknown>,
  skills?: SkillLibrary,
): OttoTool[] {
  const { context, computer, pause, confirm } = turn;
  const { threadId, signal } = context;
  const screenshot = async () => {
    const bytes = await computer.screenshot(threadId, signal);
    signal.throwIfAborted();
    if (bytes && computer.screenStatus && computer.screenStatus(threadId).state !== 'live')
      throw new Error(
        'A live browser screenshot is unavailable. Reopen the page and take a fresh screenshot before continuing. Do not repeat an action whose result is uncertain.',
      );
    return bytes;
  };
  const link = async (url: unknown, text: (url: string) => string) => {
    if (typeof url !== 'string') throw new Error('The sign-in link is unavailable.');
    await pause('question', text(url));
    return 'Waiting for the user to sign in.';
  };
  const tools = [
    ...(skills
      ? [
          bind(toolDefinitions.skills, async (p) =>
            p.action === 'list' ? skills.catalog : skills.read(p.name, p.file),
          ),
        ]
      : []),
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
        return pageText(
          await computer.upload(
            threadId,
            { selector: rest.selector, name: basename(rest.path), bytes },
            signal,
          ),
        );
      }
      return pageText(await computer.act(threadId, { action, ...rest } as BrowserAction, signal));
    }),
    bind(toolDefinitions.browser_flow, browserFlows),
    bind(toolDefinitions.get_credential, async (input) => {
      if (!('kind' in input)) {
        const result = await context.requestCredential(input);
        if (!result.credential) throw new Error('This saved login is unavailable.');
        return result.credential;
      }
      const { message, action, ...request } = input;
      const result = await context.requestCredential(request);
      if (result.filled)
        return request.kind === 'otp'
          ? 'Verification code entered privately.'
          : 'Saved login entered.';
      if (!result.url) throw new Error('The secure sign-in request could not be created.');
      await turn.invite(vaultInvitation(request.origin, result.url, message, action));
      await pause('credentials', undefined, { post: false });
      return 'Waiting for secure input.';
    }),
    bind(toolDefinitions.browser_session, async (p) => {
      if (!context.browserConnection) throw new Error('Browser connections are unavailable.');
      const result = (await context.browserConnection(p)) as Record<string, unknown>;
      if (result.status === 'rejected') {
        switch (result.code) {
          case 'invalid_browser_connection_arguments':
            throw new Error(
              'Invalid browser session input. Valid forms: connect {url, label?}; use {url, connectionId}; save {url, connectionId, signedIn:true}.',
            );
          case 'browser_connection_origin_mismatch':
            throw new Error(
              'This browser connection belongs to a different website. Use a saved connection for the current origin.',
            );
          case 'browser_connection_unavailable':
            throw new Error(
              'This browser connection is unavailable for the current task. List saved connections and inspect the current page before choosing one.',
            );
          default:
            throw new Error(
              'The browser session request was rejected. Check the current page and saved connection before trying again.',
            );
        }
      }
      if (p.action === 'connect' || result.status === 'needs_sign_in') {
        const { url: _url, ...safe } = result;
        return safe;
      }
      return result;
    }),
    bind(toolDefinitions.apps, async (p) => {
      const result = await context.integration(p.action, p.args, signal);
      signal.throwIfAborted();
      return result && typeof result === 'object' && appConfirmation in result
        ? confirm({ requiresConfirmation: true, question: result[appConfirmation] })
        : result;
    }),
    bind(toolDefinitions.manage_apps, async (p) => {
      if (!context.connections) throw new Error('Apps are unavailable.');
      const result = await context.connections(p.action, p.service, p.proposal, p.newAccount);
      if (p.action === 'list') return result;
      const { name, url, accounts } = result as {
        name?: unknown;
        url?: unknown;
        accounts?: unknown;
      };
      if (accounts) return { status: 'already_connected', accounts };
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
    bind(toolDefinitions.task, async (p) => {
      if (!context.task) throw new Error('Tasks are unavailable.');
      return context.task(p);
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
  return Object.values(toolDefinitions).map(({ name, description, parameters }) =>
    structuredClone({ name, description, parameters }),
  );
}
