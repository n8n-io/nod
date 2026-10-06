import { z } from 'zod';
import { browserUploadBytes } from '../../ports/computer.ts';
import { browserHandoffInput } from '../../shared/browser-handoff.ts';

export const browserSocketPath = '/data/control.sock';
export const responseBytes = 17 * 1024 * 1024;
export const imageBytes = 12 * 1024 * 1024;

const identity = {
  id: z.uuid(),
  namespace: z.string().regex(/^sk-[a-f0-9]{24}$/),
};
const thread = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const selector = z.string().min(1).max(500);
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
export const browserDownloadInput = z
  .object({
    selector: selector.optional(),
    url: z.string().min(1).max(8192).optional(),
    name: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^/\\\u0000-\u001f\u007f]+$/)
      .optional(),
  })
  .strict()
  .refine((input) => !(input.selector && input.url));
const browserAction = z
  .object({
    action: z.enum([
      'open',
      'snapshot',
      'click',
      'fill',
      'type',
      'press',
      'scroll',
      'select',
      'check',
      'uncheck',
      'hover',
      'drag',
      'back',
      'forward',
      'reload',
      'tab_list',
      'tab_switch',
      'evaluate',
      'wait',
      'accept_dialog',
      'dismiss_dialog',
    ]),
    url: z.string().max(8192).optional(),
    script: z.string().max(20_000).optional(),
    tabId: z.string().min(1).max(200).optional(),
    selector: selector.optional(),
    targetSelector: selector.optional(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    points: z.array(point).min(2).max(100).optional(),
    durationMs: z.number().int().min(0).max(15_000).optional(),
    text: z.string().max(20_000).optional(),
    key: z.string().max(40).optional(),
    load: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    direction: z.enum(['up', 'down']).optional(),
    waitMs: z.number().int().min(0).max(15_000).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    timeZone: z.string().max(100).optional(),
    locale: z.string().max(35).optional(),
  })
  .strict();
const credential = z
  .object({
    threadId: thread,
    origin: z.string().max(2048),
    kind: z.enum(['identifier', 'password', 'otp']).optional(),
    username: z.string().max(8192).optional(),
    password: z.string().max(8192).optional(),
    code: z.string().max(8192).optional(),
    usernameSelector: selector.optional(),
    passwordSelector: selector.optional(),
  })
  .strict();

export const browserRequest = z.discriminatedUnion('method', [
  z
    .object({ ...identity, method: z.literal('act'), threadId: thread, input: browserAction })
    .strict(),
  z
    .object({
      ...identity,
      method: z.literal('bindProfile'),
      threadId: thread,
      profileId: z.uuid(),
    })
    .strict(),
  z.object({ ...identity, method: z.literal('deleteProfile'), profileId: z.uuid() }).strict(),
  z
    .object({
      ...identity,
      method: z.literal('download'),
      threadId: thread,
      input: browserDownloadInput,
    })
    .strict(),
  z
    .object({
      ...identity,
      method: z.literal('upload'),
      threadId: thread,
      input: z
        .object({
          selector,
          name: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^/\\\u0000-\u001f\u007f]+$/),
          data: z
            .string()
            .min(4)
            .max(Math.ceil(browserUploadBytes / 3) * 4),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...identity, method: z.literal('screenshot'), threadId: thread }).strict(),
  z
    .object({
      ...identity,
      method: z.literal('control'),
      threadId: thread,
      input: browserHandoffInput,
    })
    .strict(),
  z.object({ ...identity, method: z.literal('currentPage'), threadId: thread }).strict(),
  z.object({ ...identity, method: z.literal('injectCredentials'), input: credential }).strict(),
  z
    .object({
      ...identity,
      method: z.literal('hold'),
      threadId: thread,
      until: z.number().finite().nullable(),
    })
    .strict(),
  z.object({ ...identity, method: z.literal('close'), threadId: thread }).strict(),
  z.object({ ...identity, method: z.literal('discard'), threadId: thread }).strict(),
  z.object({ ...identity, method: z.literal('dispose') }).strict(),
  z.object({ ...identity, method: z.literal('quiesce') }).strict(),
  z.object({ ...identity, method: z.literal('status') }).strict(),
]);

export type BrowserRequest = z.infer<typeof browserRequest>;
export type BrowserCall = BrowserRequest extends infer R
  ? R extends BrowserRequest
    ? Omit<R, 'id' | 'namespace'>
    : never
  : never;
export const browserFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), request: browserRequest }).strict(),
  z.object({ type: z.literal('cancel'), id: z.uuid() }).strict(),
]);
export const browserMetadata = z
  .object({
    status: z.string().max(256),
    currentSession: z
      .object({ threadId: thread, lastActivityAt: z.iso.datetime() })
      .strict()
      .nullable(),
    screen: z
      .object({
        threadId: thread,
        state: z.enum(['live', 'last_known', 'unavailable']),
        capturedAt: z.iso.datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserMetadata = z.infer<typeof browserMetadata>;
export const browserResponse = z.discriminatedUnion('ok', [
  z
    .object({ id: z.uuid(), ok: z.literal(true), result: z.unknown(), metadata: browserMetadata })
    .strict(),
  z
    .object({
      id: z.uuid(),
      ok: z.literal(false),
      error: z.enum([
        'cancelled',
        'locked',
        'navigation',
        'click_intercepted',
        'dialog',
        'action',
        'observation',
        'unavailable',
      ]),
      metadata: browserMetadata,
    })
    .strict(),
]);
export type BrowserResponse = z.infer<typeof browserResponse>;
