import { feedbackLimits, type FeedbackSubmission } from '../../shared/feedback';
import { parseFeedbackAttachment, type FeedbackAttachment } from './feedback-attachment';

export type FeedbackDraft = {
  category: FeedbackSubmission['category'];
  feedback: string;
  attachments: FeedbackAttachment[];
  pendingId: string | null;
  reportChoice: boolean | null;
};

export function hasFeedbackDraft(draft: FeedbackDraft) {
  return (
    !!draft.feedback || !!draft.attachments.length || draft.category !== 'bug' || !!draft.pendingId
  );
}

export function readFeedbackPending(key: string) {
  try {
    const id = window.localStorage.getItem(key);
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

export function writeFeedbackPending(key: string, id: string | null) {
  try {
    if (id) window.localStorage.setItem(key, id);
    else window.localStorage.removeItem(key);
  } catch {}
}

const writes = new Map<string, Promise<void>>();

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nod-feedback', 1);
    let settled = false;
    const fail = () => {
      settled = true;
      clearTimeout(timer);
      reject(new Error('Draft storage is unavailable.'));
    };
    const timer = setTimeout(fail, 5000);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transaction(
  ownerId: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
  consume: (value: unknown, store: IDBObjectStore) => unknown = (value) => value,
) {
  if (!ownerId) throw new Error('A draft owner is required.');
  const db = await database();
  return new Promise<unknown>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction('drafts', mode);
    } catch (cause) {
      db.close();
      reject(cause);
      return;
    }
    const timer = setTimeout(() => tx.abort(), 5000);
    const finish = () => {
      clearTimeout(timer);
      db.close();
    };
    tx.onabort = tx.onerror = () => {
      finish();
      reject(new Error('Draft storage is unavailable.'));
    };
    try {
      const store = tx.objectStore('drafts');
      const request = operation(store);
      let value: unknown;
      request.onsuccess = () => {
        try {
          value = consume(request.result, store);
        } catch (cause) {
          tx.abort();
          finish();
          reject(cause);
        }
      };
      tx.oncomplete = () => {
        finish();
        resolve(value);
      };
    } catch (cause) {
      tx.abort();
      finish();
      reject(cause);
    }
  });
}

function storedFile(file: File) {
  return {
    name: file.name,
    lastModified: file.lastModified,
    blob: file.slice(0, file.size, file.type),
  };
}

function restoredFile(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const file = value as Record<string, unknown>;
  if (
    typeof file.name !== 'string' ||
    !file.name.trim() ||
    file.name.length > 160 ||
    /[\\/\u0000-\u001f\u007f]/.test(file.name) ||
    typeof file.lastModified !== 'number' ||
    !Number.isFinite(file.lastModified) ||
    !(file.blob instanceof Blob)
  )
    return null;
  return new File([file.blob], file.name, {
    type: file.blob.type,
    lastModified: file.lastModified,
  });
}

function decode(value: unknown, ownerId: string): FeedbackDraft | null {
  if (value === undefined) return null;
  const fail = () => {
    throw new Error('The saved draft could not be restored.');
  };
  if (!value || typeof value !== 'object') return fail();
  const saved = value as Record<string, unknown>;
  if (
    saved.version !== 1 ||
    saved.ownerId !== ownerId ||
    !saved.draft ||
    typeof saved.draft !== 'object'
  )
    return fail();
  const draft = saved.draft as Record<string, unknown>;
  if (
    !['bug', 'feature', 'other'].includes(String(draft.category)) ||
    typeof draft.feedback !== 'string' ||
    draft.feedback.length > feedbackLimits.text ||
    (draft.pendingId !== null &&
      (typeof draft.pendingId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          draft.pendingId,
        ))) ||
    (draft.reportChoice !== undefined &&
      draft.reportChoice !== null &&
      typeof draft.reportChoice !== 'boolean') ||
    !Array.isArray(draft.attachments) ||
    draft.attachments.length > feedbackLimits.attachments
  )
    return fail();
  const attachments = draft.attachments
    .map((value) => {
      if (!value || typeof value !== 'object') return fail();
      const item = value as Record<string, unknown>;
      const image = item.image as Record<string, unknown> | undefined;
      const restored = parseFeedbackAttachment({
        id: item.id,
        file: restoredFile(item.file),
        ...(image === undefined
          ? {}
          : { image: { original: restoredFile(image?.original), marks: image?.marks } }),
      });
      return restored ?? fail();
    })
    .filter(
      (item) =>
        draft.reportChoice !== undefined ||
        (item.file.name !== 'nod-screenshot.jpg' &&
          item.image?.original.name !== 'nod-screenshot.jpg'),
    );
  if (
    new Set(attachments.map((item) => item.id)).size !== attachments.length ||
    attachments.reduce((total, item) => total + item.file.size, 0) >
      feedbackLimits.totalAttachmentBytes
  )
    return fail();
  return {
    category: draft.category as FeedbackDraft['category'],
    feedback: draft.feedback,
    pendingId: draft.pendingId as string | null,
    reportChoice: typeof draft.reportChoice === 'boolean' ? draft.reportChoice : null,
    attachments,
  };
}

function encode(ownerId: string, draft: FeedbackDraft) {
  return {
    version: 1,
    ownerId,
    draft: {
      ...draft,
      attachments: draft.attachments.map((item) => ({
        id: item.id,
        file: storedFile(item.file),
        ...(item.image
          ? { image: { original: storedFile(item.image.original), marks: item.image.marks } }
          : {}),
      })),
    },
  };
}

export async function loadFeedbackDraft(ownerId: string) {
  await writes.get(ownerId)?.catch(() => {});
  return transaction(
    ownerId,
    'readwrite',
    (store) => store.get(ownerId),
    (value, store) => {
      const draft = decode(value, ownerId);
      if (
        draft &&
        (value as { draft: { reportChoice?: unknown } }).draft.reportChoice === undefined
      )
        store.put(encode(ownerId, draft), ownerId);
      return draft;
    },
  ) as Promise<FeedbackDraft | null>;
}

export function saveFeedbackDraft(ownerId: string, draft: FeedbackDraft | null) {
  const pending = writes.get(ownerId) ?? Promise.resolve();
  const task = pending
    .catch(() => {})
    .then(async () => {
      const value = draft && encode(ownerId, draft);
      await transaction(ownerId, 'readwrite', (store) =>
        value ? store.put(value, ownerId) : store.delete(ownerId),
      );
    })
    .finally(() => {
      if (writes.get(ownerId) === task) writes.delete(ownerId);
    });
  writes.set(ownerId, task);
  return task;
}
