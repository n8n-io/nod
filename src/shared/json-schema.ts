export function withoutSchemaPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSchemaPatterns);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      key === 'pattern' || key === 'patternProperties' ? [] : [[key, withoutSchemaPatterns(item)]],
    ),
  );
}
