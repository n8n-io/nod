export function validateRequestText(input: unknown) {
  const pending = [input];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (value.includes('\0'))
        throw Object.assign(
          new Error('Text cannot contain a null character (U+0000). Remove it and try again.'),
          { statusCode: 400 },
        );
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
      for (const [key, item] of Object.entries(value)) pending.push(key, item);
    }
  }
}
