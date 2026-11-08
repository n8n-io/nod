function clean(value: unknown, propertyMap: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => clean(item, false));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!propertyMap && (key === 'pattern' || key === 'patternProperties')) return [];
      const nested =
        !propertyMap && ['properties', '$defs', 'definitions', 'dependentSchemas'].includes(key);
      return [[key, clean(item, nested)]];
    }),
  );
}

export function withoutSchemaPatterns(value: unknown): unknown {
  return clean(value, false);
}
