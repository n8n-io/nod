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

function clean(
  value: unknown,
  propertyMap: boolean,
  state: { patterns: boolean; relax: boolean },
): unknown {
  if (Array.isArray(value)) return value.map((item) => clean(item, false, state));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!propertyMap && (key === 'pattern' || key === 'patternProperties')) {
        state.patterns = true;
        return [];
      }
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
            ? clean(item, false, state)
            : maps.has(key)
              ? clean(item, true, state)
              : schemas.has(key)
                ? clean(item, false, state)
                : item,
        ],
      ];
    }),
  );
  if (!propertyMap && state.relax) {
    delete result.not;
    delete result.if;
    delete result.maxContains;
    for (const key of ['unevaluatedProperties', 'unevaluatedItems'])
      if (Object.hasOwn(result, key)) result[key] = true;
    if (Array.isArray(result.oneOf)) {
      if (Object.hasOwn(result, 'anyOf'))
        result.allOf = [
          ...(Array.isArray(result.allOf) ? result.allOf : []),
          { anyOf: result.oneOf },
        ];
      else result.anyOf = result.oneOf;
      delete result.oneOf;
    }
  }
  return result;
}

export function withoutSchemaPatterns(value: unknown): unknown {
  const state = { patterns: false, relax: false };
  const cleaned = clean(value, false, state);
  state.relax = state.patterns;
  return state.relax ? clean(cleaned, false, state) : cleaned;
}
