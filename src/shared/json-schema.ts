import { NextStack, Resolve, Stack } from 'typebox/schema';

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

function patternDependencies(root: unknown) {
  const parents = new Map<object, { all: Set<object>; evaluated: Set<object> }>();
  const visited = new Set<object>();
  const affected = new Set<object>();
  const detached = new Set<object>();
  const resources = new Map<object, object>();
  const imports: Array<{ from: object; key: string; target: object | boolean }> = [];
  const references: Array<{
    from: object;
    key: string;
    ref: string;
    stack: ReturnType<typeof Stack>;
  }> = [];
  const rootStack = Stack({}, root as Parameters<typeof Stack>[1]);
  const visit = (
    value: unknown,
    parent?: object,
    moved = false,
    sameInstance = false,
    resource?: object,
    stack = rootStack,
  ) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent, moved, sameInstance, resource, stack);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value !== root) stack = NextStack(stack, value as Parameters<typeof NextStack>[1]);
    resource = typeof (value as { $id?: unknown }).$id === 'string' ? value : (resource ?? value);
    if (!resources.has(value)) resources.set(value, resource);
    if (moved) detached.add(value);
    if (parent) {
      const linked = parents.get(value) ?? { all: new Set<object>(), evaluated: new Set<object>() };
      linked.all.add(parent);
      if (sameInstance) linked.evaluated.add(parent);
      parents.set(value, linked);
    }
    if (visited.has(value)) return;
    visited.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (key === 'pattern' || key === 'patternProperties') affected.add(value);
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && typeof item === 'string')
        references.push({ from: value, key, ref: item, stack });
      if ((maps.has(key) || key === 'patternProperties') && item && typeof item === 'object')
        for (const schema of Object.values(item))
          visit(
            schema,
            ['$defs', 'definitions'].includes(key) ? undefined : value,
            moved || key === 'patternProperties',
            ['dependentSchemas', 'dependencies'].includes(key),
            resource,
            stack,
          );
      else if (schemas.has(key))
        visit(
          item,
          value,
          moved || ['oneOf', 'not', 'if'].includes(key),
          ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else'].includes(key),
          resource,
          stack,
        );
    }
  };
  visit(root);
  const primary = new Set(visited);
  for (const { from, key, ref, stack } of references) {
    try {
      const resolved = Resolve.Ref(stack, { $ref: ref });
      const target = resolved.schema;
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        const moved = !primary.has(target) || detached.has(target);
        visit(target, from, moved, true, resources.get(from), resolved.stack);
        if (moved) imports.push({ from, key, target });
      } else if (
        typeof target === 'boolean' &&
        !(ref.startsWith('#/$defs/') && !ref.slice(8).includes('/'))
      )
        imports.push({ from, key, target });
    } catch {}
  }
  const propagate = (marked: Set<object>, key: 'all' | 'evaluated') => {
    const queue = [...marked];
    for (const value of queue)
      for (const parent of parents.get(value)?.[key] ?? [])
        if (!marked.has(parent)) {
          marked.add(parent);
          queue.push(parent);
        }
  };
  propagate(affected, 'all');
  const evaluationLoss = new Set<object>();
  for (const value of visited) {
    const schema = value as Record<string, unknown>;
    if (
      Object.hasOwn(schema, 'patternProperties') ||
      (schema.if && typeof schema.if === 'object' && affected.has(schema.if))
    )
      evaluationLoss.add(value);
  }
  propagate(evaluationLoss, 'evaluated');
  return { affected, evaluationLoss, imports, resources };
}

function clean(
  value: unknown,
  propertyMap: boolean,
  state: {
    affected: Set<object>;
    evaluationLoss: Set<object>;
    references: Map<object, Map<string, string>>;
    definitions: Map<object, Map<object | boolean, string>>;
    defining: Set<object>;
  },
): unknown {
  if (Array.isArray(value)) return value.map((item) => clean(item, false, state));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const depends = (item: unknown): boolean =>
    Array.isArray(item)
      ? item.some(depends)
      : !!item && typeof item === 'object' && state.affected.has(item);
  const result = Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!propertyMap && (key === 'pattern' || key === 'patternProperties')) return [];
      if (!propertyMap && ['not', 'if'].includes(key) && depends(item)) return [];
      if (!propertyMap && key === 'maxContains' && depends(source.contains)) return [];
      if (
        !propertyMap &&
        ['$ref', '$dynamicRef', '$recursiveRef'].includes(key) &&
        state.references.get(value)?.has(key)
      )
        return [[key, state.references.get(value)!.get(key)]];
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
  if (!propertyMap && state.evaluationLoss.has(value)) {
    for (const key of ['unevaluatedProperties', 'unevaluatedItems'])
      if (Object.hasOwn(result, key)) result[key] = true;
  }
  if (!propertyMap && Array.isArray(result.oneOf) && depends(source.oneOf)) {
    if (Object.hasOwn(result, 'anyOf'))
      result.allOf = [
        ...(Array.isArray(result.allOf) ? result.allOf : []),
        { anyOf: result.oneOf },
      ];
    else result.anyOf = result.oneOf;
    delete result.oneOf;
  }
  const definitions =
    propertyMap || state.defining.has(value) ? undefined : state.definitions.get(value);
  if (definitions?.size) {
    state.defining.add(value);
    result.$defs = {
      ...(result.$defs && typeof result.$defs === 'object' ? result.$defs : {}),
      ...Object.fromEntries(
        [...definitions].map(([target, key]) => [key, clean(target, false, state)]),
      ),
    };
    state.defining.delete(value);
  }
  return result;
}

export function withoutSchemaPatterns(value: unknown): unknown {
  const { affected, evaluationLoss, imports, resources } = patternDependencies(value);
  const references = new Map<object, Map<string, string>>();
  const definitions = new Map<object, Map<object | boolean, string>>();
  const state = { affected, evaluationLoss, references, definitions, defining: new Set<object>() };
  if (!affected.size) return clean(value, false, state);
  let next = 0;
  for (const { from, key: keyword, target } of imports) {
    const resource = resources.get(from)!;
    const local = definitions.get(resource) ?? new Map<object | boolean, string>();
    definitions.set(resource, local);
    const existing = (resource as { $defs?: unknown }).$defs;
    let key = local.get(target);
    if (!key) {
      do key = `__nod_ref_${next++}`;
      while (existing && typeof existing === 'object' && Object.hasOwn(existing, key));
      local.set(target, key);
    }
    const replacements = references.get(from) ?? new Map<string, string>();
    replacements.set(keyword, `#/$defs/${key}`);
    references.set(from, replacements);
  }
  return clean(value, false, state);
}
