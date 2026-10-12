export function isReversiblePlanAction(action: string) {
  return ['OTTO_schedule_create', 'OTTO_schedule_update', 'OTTO_schedule_cancel'].includes(action);
}
