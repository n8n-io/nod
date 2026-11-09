import { browserErrorCodes } from '../../shared/browser-errors.ts';
import { z } from 'zod';
import { browserHandoffInput } from '../../shared/browser-handoff.ts';
import { fileBytes } from '../../shared/files.ts';

export const browserSocketPath = '/data/control.sock';
export const responseBytes = 17 * 1024 * 1024;
export const imageBytes = 12 * 1024 * 1024;
export const transferBytes = 4 * 1024 * 1024;
const transferData = z
  .string()
  .min(4)
  .max(Math.ceil(transferBytes / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

const identity = {
  id: z.uuid(),
  namespace: z.string().regex(/^sk-[a-f0-9]{24}$/),
};
const thread = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const selector = z.string().min(1);
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
const browserDownloadInput = z
  .object({
    selector: selector.optional(),
    url: z.string().min(1).optional(),
    name: z
      .string()
      .min(1)
      .regex(/^[^/\\\u0000-\u001f\u007f]+$/)
      .optional(),
    expectOrigin: z.string().min(1).max(2048).optional(),
    expectUrl: z.string().min(1).max(8192).optional(),
    expectTarget: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
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
    url: z.string().optional(),
    script: z.string().optional(),
    tabId: z.string().min(1).max(200).optional(),
    selector: selector.optional(),
    targetSelector: selector.optional(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    points: z.array(point).min(2).optional(),
    durationMs: z.number().int().min(0).optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    load: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().int().min(1).optional(),
    waitMs: z.number().int().min(0).optional(),
    offset: z.number().int().min(0).optional(),
    timeZone: z.string().max(100).optional(),
    locale: z.string().max(35).optional(),
    expectOrigin: z.string().min(1).max(2048).optional(),
    expectUrl: z.string().min(1).max(8192).optional(),
    expectTarget: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    readOnly: z.boolean().optional(),
  })
  .strict();
export const browserCredentialInput = z.object({
  threadId: thread,
  origin: z.string().max(2048),
  kind: z.enum(['identifier', 'password', 'otp']).optional(),
  username: z.string().max(8192).optional(),
  password: z.string().max(8192).optional(),
  code: z.string().max(8192).optional(),
  usernameSelector: selector.optional(),
  passwordSelector: z.union([selector, z.array(selector).min(1).max(100)]).optional(),
  submitSelector: selector.optional(),
});

const expiryField = z.union([
  selector,
  z
    .object({ selector, format: z.string().min(1).max(100), locale: z.string().max(35).optional() })
    .strict(),
]);
const cardFields = z
  .object({
    number: selector,
    expiry: expiryField.optional(),
    expiryMonth: expiryField.optional(),
    expiryYear: expiryField.optional(),
    securityCode: selector.optional(),
    name: selector.optional(),
  })
  .strict();

export const browserCardInput = z.object({
  threadId: thread,
  fields: cardFields,
  submitSelector: selector.optional(),
  document: z.string().min(1).max(200),
  destinations: z
    .object({
      number: z.string().max(2048).optional(),
      expiry: z.string().max(2048).optional(),
      expiryMonth: z.string().max(2048).optional(),
      expiryYear: z.string().max(2048).optional(),
      securityCode: z.string().max(2048).optional(),
      name: z.string().max(2048).optional(),
    })
    .strict(),
  card: z
    .object({
      cardNumber: z.string().regex(/^\d{12,19}$/),
      expiryMonth: z.number().int().min(1).max(12),
      expiryYear: z.number().int().min(2000).max(9999),
      cardholder: z.string().max(200),
      securityCode: z
        .string()
        .regex(/^\d{3,4}$/)
        .optional(),
    })
    .strict(),
});

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
            .regex(/^[^/\\\u0000-\u001f\u007f]+$/),
          size: z.number().int().min(1).max(fileBytes),
          expectOrigin: z.string().min(1).max(2048).optional(),
          expectUrl: z.string().min(1).max(8192).optional(),
          expectTarget: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...identity, method: z.literal('screenshot'), threadId: thread }).strict(),
  z.object({ ...identity, method: z.literal('view'), threadId: thread }).strict(),
  z
    .object({
      ...identity,
      method: z.literal('currentPage'),
      threadId: thread,
      input: browserAction.optional(),
    })
    .strict(),
  z
    .object({
      ...identity,
      method: z.literal('signInMethods'),
      threadId: thread,
      origin: z.string().min(1).max(2048),
      methods: z
        .array(z.object({ label: z.string().max(300), selector: selector.max(8192) }).strict())
        .min(1)
        .max(10),
    })
    .strict(),
  z
    .object({
      ...identity,
      method: z.literal('selectSignInMethod'),
      threadId: thread,
      input: z
        .object({
          origin: z.string().min(1).max(2048),
          document: z.string().min(1).max(200),
          methodId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...identity,
      method: z.literal('injectCredentials'),
      input: browserCredentialInput.strict(),
    })
    .strict(),
  z
    .object({ ...identity, method: z.literal('fillCard'), input: browserCardInput.strict() })
    .strict(),
  z
    .object({
      ...identity,
      method: z.literal('cardDestinations'),
      threadId: thread,
      fields: cardFields,
    })
    .strict(),
  z.object({ ...identity, method: z.literal('checkoutImage'), threadId: thread }).strict(),
  z
    .object({
      ...identity,
      method: z.literal('hold'),
      threadId: thread,
      held: z.boolean(),
    })
    .strict(),
  z.object({ ...identity, method: z.literal('close'), threadId: thread }).strict(),
  z.object({ ...identity, method: z.literal('clear'), threadId: thread }).strict(),
  z.object({ ...identity, method: z.literal('discard'), threadId: thread }).strict(),
  z.object({ ...identity, method: z.literal('dispose') }).strict(),
  z.object({ ...identity, method: z.literal('quiesce') }).strict(),
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
  z
    .object({
      type: z.literal('input'),
      id: z.uuid(),
      inputId: z.uuid(),
      input: browserHandoffInput,
    })
    .strict(),
  z.object({ type: z.literal('data'), id: z.uuid(), data: transferData }).strict(),
]);
export const chunkFrame = z.object({ id: z.uuid(), chunk: transferData }).strict();
export const viewFrame = z
  .object({
    id: z.uuid(),
    frame: z
      .string()
      .max(4 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
export const browserInputResult = z.discriminatedUnion('ok', [
  z
    .object({
      id: z.uuid(),
      inputId: z.uuid(),
      ok: z.literal(true),
      text: z.string().max(262_144).optional(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      inputId: z.uuid(),
      ok: z.literal(false),
      error: z.enum(browserErrorCodes).optional(),
    })
    .strict(),
]);
export const browserViewResult = z.union([viewFrame, browserInputResult]);
export const browserMetadata = z
  .object({
    status: z.string().max(256),
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
      error: z.union([z.enum(['cancelled', 'locked', 'unavailable']), z.enum(browserErrorCodes)]),
      detail: z.string().optional(),
      metadata: browserMetadata,
    })
    .strict(),
]);
export type BrowserResponse = z.infer<typeof browserResponse>;
