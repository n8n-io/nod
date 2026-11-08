const maps = new Set(['properties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const schemas = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);

function clean(value: unknown, propertyMap: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => clean(item, false));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!propertyMap && (key === 'pattern' || key === 'patternProperties')) return [];
      if (
        !propertyMap &&
        Object.hasOwn(value, 'patternProperties') &&
        ['additionalProperties', 'unevaluatedProperties'].includes(key)
      )
        return [[key, true]];
      return [
        [
          key,
          propertyMap
            ? clean(item, false)
            : maps.has(key)
              ? clean(item, true)
              : schemas.has(key)
                ? clean(item, false)
                : item,
        ],
      ];
    }),
  );
}

export function withoutSchemaPatterns(value: unknown): unknown {
  return clean(value, false);
}
