export function isReversiblePlanAction(action: string) {
  return ['OTTO_schedule_create', 'OTTO_schedule_update', 'OTTO_schedule_cancel'].includes(action);
}

export function confirmationAnswer(text: string) {
  const value = text
    .trim()
    .replace(/[.!]+$/, '')
    .toLowerCase();
  if (
    /^(?:yes|yes please|confirm|confirmed|go ahead|do it|sim|sim por favor|confirmo|podes avançar)$/.test(
      value,
    )
  )
    return true;
  if (/^(?:no|no thanks|cancel|don't|do not|não|nao|cancela|cancelar)$/.test(value)) return false;
  return undefined;
}
