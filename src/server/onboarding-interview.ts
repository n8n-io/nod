import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import { ObjectStoreConflict, type PrivateObjectStore } from '../ports/object-storage.ts';
import {
  interviewAnswerChars,
  interviewQuestions,
  type OnboardingInterview,
  type OnboardingInterviewState,
} from '../shared/onboarding.ts';
import { line, unsafe } from './memory-tree.ts';
import { createMemoryService } from './memory.ts';
import { lockKey } from './locks.ts';
import { createPostgresObjectStore } from './object-storage.ts';
import { transaction } from './transaction.ts';
import { openVaultValue, sealVaultValue } from './vault-crypto.ts';

const messageChars = 1000;
const saveInput = z
  .object({
    generation: z.uuid().optional(),
    answers: z.array(line(interviewAnswerChars)).min(1).max(interviewQuestions),
  })
  .strict();
const draftKey = 'onboarding/interview';
const draftBytes = 128 * 1024;
const draftLifetime = 30 * 24 * 60 * 60 * 1000;
const activeDraft = z
  .object({
    generation: z.uuid(),
    completed: z.literal(false),
    answers: z.array(line(interviewAnswerChars)).max(interviewQuestions),
    turns: z.array(z.array(z.string().max(messageChars)).max(3)).max(interviewQuestions + 1),
    done: z.boolean(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) =>
      value.turns.length >= value.answers.length &&
      value.turns.length <= value.answers.length + 1 &&
      (!value.done || value.turns.length === value.answers.length + 1),
  );
const draftSchema = z.union([
  activeDraft,
  z
    .object({
      generation: z.uuid(),
      completed: z.literal(true),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
]);

const emptyDraft = (): OnboardingInterview => ({
  generation: randomUUID(),
  completed: false,
  answers: [],
  turns: [],
  done: false,
});
const conflict = () =>
  Object.assign(new Error('Your setup answers changed. Reload them before continuing.'), {
    statusCode: 409,
  });
function validateAnswers(answers: string[]) {
  if (answers.some((text) => unsafe(text)) || unsafe(answers.join('')))
    throw Object.assign(new Error('Passwords, codes and card numbers can’t be saved as notes.'), {
      statusCode: 400,
    });
}

export function createOnboardingInterview(options: {
  ownerId: string;
  pool: Pool;
  keyStore: CredentialKeyStore;
}) {
  const binding = ['nod-onboarding-interview-v1', options.ownerId];
  function locked<T>(run: (store: PrivateObjectStore, client: PoolClient) => Promise<T>) {
    return transaction(async (client) => {
      await lockKey(client, `onboarding-interview:${options.ownerId}`);
      return run(createPostgresObjectStore({ database: client, ownerId: options.ownerId }), client);
    }, options.pool).catch((error) => {
      if (error instanceof ObjectStoreConflict) throw conflict();
      throw error;
    });
  }
  async function load(store: PrivateObjectStore) {
    const object = await store.read(draftKey, draftBytes);
    if (!object) return { draft: undefined, version: null };
    const key = await options.keyStore.getKey();
    let saved: z.infer<typeof draftSchema>;
    try {
      saved = draftSchema.parse(
        JSON.parse(openVaultValue(key, binding, Buffer.from(object.bytes).toString())),
      );
    } catch {
      return { draft: undefined, version: object.version, unreadable: true };
    }
    if (saved.expiresAt <= Date.now()) {
      await store.remove(draftKey, { expectedVersion: object.version });
      return { draft: undefined, version: null };
    }
    const { expiresAt: _, ...draft } = saved;
    return {
      draft: draft.completed ? { ...draft, answers: [], turns: [], done: true } : draft,
      version: object.version,
    };
  }
  async function saveDraft(
    store: PrivateObjectStore,
    draft: OnboardingInterview,
    version: string | null,
  ) {
    const value = draftSchema.parse({
      ...(draft.completed ? { generation: draft.generation, completed: true } : draft),
      expiresAt: Date.now() + draftLifetime,
    });
    const bytes = Buffer.from(
      sealVaultValue(await options.keyStore.getKey(), binding, JSON.stringify(value)),
    );
    if (bytes.length > draftBytes) throw new Error('Your setup answers are too long.');
    return store.write(draftKey, bytes, { expectedVersion: version });
  }
  async function remember(raw: unknown) {
    const { generation, answers } = saveInput.parse(raw);
    if (!generation) throw conflict();
    return locked(async (store, client) => {
      validateAnswers(answers);
      const saved = await load(store);
      if (!saved.draft || saved.draft.generation !== generation) throw conflict();
      if (saved.draft.completed) return;
      if (JSON.stringify(saved.draft.answers) !== JSON.stringify(answers)) throw conflict();
      await createMemoryService({ pool: client, ownerId: options.ownerId, store }).restate([
        {
          area: 'about',
          slug: 'onboarding',
          text: `Told Nod during setup: ${answers.join(' / ')}`,
        },
      ]);
      await saveDraft(store, { ...saved.draft, completed: true }, saved.version);
    });
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/onboarding/interview', async (_request, response) => {
      response.header('cache-control', 'no-store');
      return locked<OnboardingInterviewState>(async (store) => {
        const saved = await load(store);
        if (saved.unreadable) return { resetVersion: saved.version };
        if (saved.draft) return saved.draft;
        const draft = emptyDraft();
        await saveDraft(store, draft, saved.version);
        return draft;
      });
    });
    app.put('/api/onboarding/interview', { bodyLimit: draftBytes }, async (request, response) => {
      response.header('cache-control', 'no-store');
      await remember(request.body);
      return { ok: true };
    });
    app.delete('/api/onboarding/interview', async (request, response) => {
      response.header('cache-control', 'no-store');
      const input = z
        .union([
          z.object({ generation: z.uuid().optional() }).strict(),
          z.object({ resetVersion: z.uuid() }).strict(),
        ])
        .parse(request.body ?? {});
      if (!('resetVersion' in input) && !input.generation) throw conflict();
      return locked(async (store) => {
        const saved = await load(store);
        if ('resetVersion' in input) {
          if (!saved.unreadable || saved.version !== input.resetVersion) throw conflict();
        } else if (!saved.draft || saved.draft.generation !== input.generation) throw conflict();
        const draft = emptyDraft();
        await saveDraft(store, draft, saved.version);
        return draft;
      });
    });
  }

  return { remember, registerRoutes };
}
