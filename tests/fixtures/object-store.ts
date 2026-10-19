import { randomUUID } from 'node:crypto';
import { ObjectStoreConflict, type PrivateObjectStore } from '../../src/ports/object-storage.ts';

export function memoryObjectStore(): PrivateObjectStore {
  const objects = new Map<string, { bytes: Uint8Array; version: string }>();
  return {
    async read(key, maxBytes) {
      const object = objects.get(key);
      if (object && object.bytes.byteLength > maxBytes)
        throw new Error('The private file is too large.');
      return object && { bytes: Uint8Array.from(object.bytes), version: object.version };
    },
    async write(key, bytes, { expectedVersion }) {
      if ((objects.get(key)?.version ?? null) !== expectedVersion) throw new ObjectStoreConflict();
      const version = randomUUID();
      objects.set(key, { bytes: Uint8Array.from(bytes), version });
      return version;
    },
    async remove(key, options = {}) {
      if (
        options.expectedVersion !== undefined &&
        objects.get(key)?.version !== options.expectedVersion
      )
        throw new ObjectStoreConflict();
      objects.delete(key);
    },
  };
}
