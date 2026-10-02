type Intent = 'update' | 'remember' | 'memory';

const ordinaryActions: Record<string, Intent[]> = {
  OTTO_profile_update: ['update', 'remember'],
  OTTO_notification_preferences_update: ['update', 'remember'],
  OTTO_memory_save: ['memory'],
};

export function isReversiblePlanAction(action: string) {
  return [
    'OTTO_goal_create',
    'OTTO_goal_update',
    'OTTO_schedule_create',
    'OTTO_schedule_update',
    'OTTO_schedule_cancel',
  ].includes(action);
}

export function requestsConnectedSchedule(action: string, instruction: string) {
  if (
    action !== 'OTTO_schedule_create' ||
    !instruction.trim() ||
    instruction.length > 12_000 ||
    /[\r\n]|<\/?[A-Za-z!]/.test(instruction)
  )
    return false;
  const request = requestedInstruction(instruction).replace(
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`|"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|(?:^|\s)'(?:\\.|[^'\\])*'(?=\s|[.,!?]|$)/g,
    ' ',
  );
  if (
    /\b(?:don['’]t|do not|never|can['’]t|cannot|without|não|nao|nunca|jamais|sem|manually|manualmente)\b/i.test(
      request,
    ) ||
    /\b(?:no|not\s+(?:a|an|the))\s+(?:(?:new|automatic|recurring|daily|weekly|monthly)\s+)*(?:schedules?|reminders?|automation)\b/i.test(
      request,
    )
  )
    return false;
  const instructions = request.split(/[.!?;]|\b(?:then|depois)\b/i).map(requestedInstruction);
  if (
    instructions.some((part) =>
      /^(?:draft|explain|describe|outline|suggest|tell\s+me\s+(?:how|whether)|show\s+me\s+how)\b/i.test(
        part,
      ),
    )
  )
    return false;
  const timing =
    /(?:(?:daily|weekly|monthly|today(?=\s+at\s+\d)|tomorrow|(?:every|each)\s+(?:day|morning|evening|night|week|weekday|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+\d{4}-\d{2}-\d{2}|amanhã|amanha|hoje(?=\s+(?:às|as)\s+\d)|(?:no\s+dia|em)\s+\d{4}-\d{2}-\d{2}|todos\s+os\s+(?:dias|sábados|sabados|domingos)|todas\s+as\s+(?:manhãs|manhas|noites|semanas|(?:segundas|terças|tercas|quartas|quintas|sextas)(?:-feiras)?))(?:\s+(?:at|às|as)\s+\d{1,2}(?::\d{2}|h\d{2})?\s*(?:am|pm)?(?:\s+(?:[A-Za-z_]+\/[A-Za-z_/]+|UTC|GMT))?)?|(?:at|às|as)\s+\d{1,2}(?::\d{2}|h\d{2})?\s*(?:am|pm)?(?:\s+(?:[A-Za-z_]+\/[A-Za-z_/]+|UTC|GMT))?)/;
  const timedPrefix = new RegExp(`^${timing.source}(?:\\s*[, :]\\s*|\\s+)(.+)$`, 'i');
  const timedSuffix = new RegExp(
    `\\s+${timing.source}(?:\\s+(?:and\\s+(?:tell|notify|alert)|e\\s+(?:avisa(?:-me)?|alerta(?:-me)?|diz(?:-me)?))(?=\\s|$).*)?\\s*$`,
    'i',
  );
  const work =
    /^(?:schedule|create\s+(?:a\s+)?(?:recurring\s+|one-off\s+)?schedule|remind\s+me|set\s+(?:up\s+)?(?:a\s+)?reminder|check|monitor|review|notify|alert|tell|run|send|agenda|lembra-me|lembre-me|verifica|avisa(?:-me)?|revê|reve|monitoriza|executa|consulta)(?=\s|$)/i;
  return instructions.some((instruction) => {
    if (
      /^(?:schedule\s+(?:(?:a|the)\s+)?(?:daily|weekly|monthly)\s+\S|create\s+(?:a\s+)?(?:daily|weekly|monthly)\s+schedule\b|set\s+(?:up\s+)?(?:a\s+)?(?:daily|weekly|monthly)\s+reminder\b)/i.test(
        instruction,
      )
    )
      return true;
    const timed = instruction.match(timedPrefix);
    if (timed && work.test(requestedInstruction(timed[1]!))) return true;
    if (!work.test(instruction)) return false;
    if (timedSuffix.test(instruction)) return true;
    const reminder = instruction.replace(/^(?:remind\s+me|lembra-me|lembre-me)\s+/i, '');
    const reminderTime = reminder !== instruction ? reminder.match(timedPrefix) : null;
    return !!reminderTime && /^(?:to|de|para)\s+/i.test(reminderTime[1]!);
  });
}

const intentWords: Record<Intent, RegExp> = {
  update:
    /^(?:update|change|edit|rename|move|reschedule|pause|cancel\s+(?:the\s+)?(?:reminder|schedule)|atualiza|altera|edita|renomeia|muda|pausa|cancela\s+(?:o\s+)?lembrete)\b/i,
  remember: /^(?:remember|save\s+(?:my|this)|learn|memoriza|lembra-te|guarda)\b/i,
  // Only a request to store something; not "remember when…", "learn from this" or other uses.
  memory:
    /^(?:remember\s+(?:that|my|i|i'm|i’m|i\s+am)|keep\s+in\s+mind\s+that|(?:save|add)\s+(?:this|that)\s+to\s+(?:your\s+)?memory|lembra-te\s+(?:de\s+)?que|memoriza\s+que)\b/i,
};

const actionScopes: Record<string, RegExp> = {
  OTTO_profile:
    /\b(?:profile|name|location|phone|preference|perfil|nome|localização|telefone|preferência)\b/i,
  OTTO_notification: /\b(?:notification|quiet|time zone|timezone|notificação|fuso)\b/i,
  OTTO_memory: /./,
};

function requestedScope(action: string, instruction: string) {
  return actionScopes[action.split('_').slice(0, 2).join('_')]?.test(instruction) === true;
}

function requestedInstruction(instruction: string) {
  return instruction
    .trim()
    .replace(
      /^(?:(?:please|can you|could you|would you|will you|i want you to|i'd like you to|i want to|help me|por favor|podes|pode|quero que)\s+)+/i,
      '',
    );
}

export function explicitlyRequestsAction(action: string, instruction: string) {
  const intents = ordinaryActions[action];
  if (
    !intents ||
    !instruction.trim() ||
    instruction.length > 12_000 ||
    !requestedScope(action, instruction)
  )
    return false;
  const request = requestedInstruction(instruction);
  if (/^(?:don't|do not|never|não)\b/i.test(request)) return false;
  return intents.some((intent) => intentWords[intent].test(request));
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
