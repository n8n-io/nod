type Intent = 'send' | 'draft' | 'create' | 'update' | 'schedule' | 'remember';

const ordinaryActions: Record<string, Intent[]> = {
  GMAIL_SEND_EMAIL: ['send'],
  GMAIL_REPLY_TO_THREAD: ['send'],
  GMAIL_CREATE_EMAIL_DRAFT: ['draft'],
  GMAIL_CREATE_DRAFT: ['draft'],
  SLACK_SEND_MESSAGE: ['send'],
  SLACK_POST_MESSAGE: ['send'],
  SLACK_OPEN_DM: ['send', 'draft'],
  SLACK_OPEN_CONVERSATION: ['send', 'draft'],
  SLACK_OPEN_AN_EXISTING_CONVERSATION: ['send', 'draft'],
  GOOGLECALENDAR_CREATE_EVENT: ['create', 'schedule'],
  GOOGLECALENDAR_UPDATE_EVENT: ['update', 'schedule'],
  GOOGLEDOCS_CREATE_DOCUMENT: ['create', 'draft'],
  GOOGLEDOCS_INSERT_TEXT: ['create', 'draft', 'update'],
  GOOGLESHEETS_CREATE_GOOGLE_SHEET1: ['create'],
  GOOGLESHEETS_UPDATE_SHEET: ['update'],
  NOTION_CREATE_NOTION_PAGE: ['create', 'draft'],
  NOTION_CREATE_A_PAGE: ['create', 'draft'],
  NOTION_APPEND_BLOCK_CHILDREN: ['create', 'draft', 'update'],
  OTTO_profile_update: ['update', 'remember'],
  OTTO_notification_preferences_update: ['update', 'remember'],
  OTTO_memory_propose: ['remember'],
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
  send: /^(?:send|post|reply|email|message|forward|envia|enviar|manda|responde|publica)\b/i,
  draft: /^(?:draft|compose|write|prepare|rascunha|prepara|escreve)\b/i,
  create: /^(?:create|make|add|write|build|cria|criar|adiciona|faz|escreve)\b/i,
  update:
    /^(?:update|change|edit|rename|move|reschedule|pause|cancel\s+(?:the\s+)?(?:reminder|schedule)|atualiza|altera|edita|renomeia|muda|pausa|cancela\s+(?:o\s+)?lembrete)\b/i,
  schedule:
    /^(?:schedule|remind\s+me|set\s+(?:up\s+)?(?:a\s+)?reminder|agenda|lembra-me|lembre-me)\b/i,
  remember: /^(?:remember|save\s+(?:my|this)|learn|memoriza|lembra-te|guarda)\b/i,
};

const actionScopes: Record<string, RegExp> = {
  GMAIL: /\b(?:e-?mail|gmail|inbox|thread|email draft)\b/i,
  SLACK: /\b(?:slack|direct message|dm)\b/i,
  GOOGLECALENDAR: /\b(?:calendar|event|meeting|appointment|calendário|reunião|evento)\b/i,
  GOOGLEDOCS: /\b(?:google docs?|document|documento)\b/i,
  GOOGLESHEETS: /\b(?:google sheets?|spreadsheet|worksheet|folha de cálculo)\b/i,
  NOTION: /\bnotion\b/i,
  OTTO_profile:
    /\b(?:profile|name|location|phone|preference|perfil|nome|localização|telefone|preferência)\b/i,
  OTTO_notification: /\b(?:notification|quiet|time zone|timezone|notificação|fuso)\b/i,
  OTTO_memory: /./,
};

function requestedScope(action: string, instruction: string) {
  const key = action.startsWith('OTTO_')
    ? action.split('_').slice(0, 2).join('_')
    : action.split('_')[0];
  return actionScopes[key]?.test(instruction) === true;
}

function requestedInstruction(instruction: string) {
  return instruction
    .trim()
    .replace(
      /^(?:(?:please|can you|could you|would you|will you|i want you to|i'd like you to|i want to|help me|por favor|podes|pode|quero que)\s+)+/i,
      '',
    );
}

export function forbidsTransmission(action: string, instruction: string) {
  if (
    ![
      'GMAIL_SEND_EMAIL',
      'GMAIL_REPLY_TO_THREAD',
      'SLACK_SEND_MESSAGE',
      'SLACK_POST_MESSAGE',
    ].includes(action)
  )
    return false;
  const request = requestedInstruction(instruction).replace(
    /"(?:\\.|[^"\\])*"|“[^”]*”|(?:^|\s)'(?:\\.|[^'\\])*'(?=\s|[.,!?]|$)/g,
    ' ',
  );
  return (
    /\b(?:don't send|do not send|not send|do not publish|don't publish|não envies|não enviar)\b/i.test(
      request,
    ) ||
    /\b(?:as\s+(?:an?\s+)?(?:unsent\s+)?draft\b|(?:keep|leave|save)(?:\s+(?:it|this|that|the\s+(?:e-?mail|message|reply)))?\s+unsent\b|unsent\s*[.!]?$)/i.test(
      request,
    ) ||
    (requestedScope(action, request) && intentWords.draft.test(request))
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
  if (forbidsTransmission(action, instruction)) return false;
  if (
    intents.includes('send') &&
    /^(?:send|forward|envia|manda)\s+(?:me|us|nos|me a mim)\b/i.test(request)
  )
    return false;
  return intents.some((intent) => intentWords[intent].test(request));
}

export function explicitlyRequestsScheduledAction(
  action: string,
  instruction: string,
  prompt: string,
) {
  if (
    action.startsWith('OTTO_') ||
    !explicitlyRequestsAction(action, prompt) ||
    forbidsTransmission(action, instruction)
  )
    return false;
  const request = requestedInstruction(instruction);
  if (/^(?:don't|do not|never|remind me|não)\b/i.test(request)) return false;
  if (explicitlyRequestsAction(action, request)) return true;
  const scheduled = request.replace(
    /^(?:schedule(?:\s+(?:a|the))?(?:\s+(?:task|job))?\s+to|create\s+(?:a\s+)?(?:recurring\s+|one-off\s+)?schedule\s+to)\s+/i,
    '',
  );
  if (scheduled !== request && explicitlyRequestsAction(action, scheduled)) return true;
  const portugueseTimed = request.replace(
    /^(?:amanhã|amanha|hoje|(?:no dia|em)\s+\d{4}-\d{2}-\d{2}|todos os (?:dias|sábados|sabados|domingos)|todas as (?:manhãs|manhas|noites|semanas|(?:segundas|terças|tercas|quartas|quintas|sextas)(?:-feiras)?))(?:\s+(?:às|as)\s+\d{1,2}(?::\d{2}|h\d{2})?(?:\s+(?:[A-Za-z_]+\/[A-Za-z_/]+|UTC|GMT))?)?[, :]?\s+/i,
    '',
  );
  if (portugueseTimed !== request) return explicitlyRequestsAction(action, portugueseTimed);
  const timed = request.replace(
    /^(?:(?:every|each)\s+(?:day|morning|evening|night|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|today|on\s+\d{4}-\d{2}-\d{2})(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s+(?:[A-Za-z_]+\/[A-Za-z_/]+|UTC|GMT))?)?[, :]?\s+/i,
    '',
  );
  return timed !== request && explicitlyRequestsAction(action, timed);
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
