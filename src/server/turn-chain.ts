export function parentTurnSql(alias = 'u') {
  return `COALESCE(CASE WHEN ${alias}.source='resume' THEN substring(${alias}.source_id from '^(?:credentials|credentials-retry|connection|control):([0-9a-f-]{36})(?::|$)')::uuid END,
      (SELECT a.turn_id FROM approvals a WHERE a.execution_turn_id=${alias}.id AND a.owner_id=${alias}.owner_id AND a.turn_id<>${alias}.id LIMIT 1))`;
}
