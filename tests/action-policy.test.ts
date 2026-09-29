import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmationAnswer,
  explicitlyRequestsAction,
  explicitlyRequestsScheduledAction,
  forbidsTransmission,
  isReversiblePlanAction,
  requestsConnectedSchedule,
} from '../src/server/action-policy.ts';
import { actionConfirmation } from '../src/server/action-presentation.ts';

test('ordinary actions require a known operation and matching explicit scope', () => {
  for (const [action, text] of [
    ['GMAIL_SEND_EMAIL', 'Send the email to alex@example.com.'],
    ['GMAIL_SEND_EMAIL', 'Please send the email draft.'],
    ['SLACK_POST_MESSAGE', 'Send the message to him on Slack then.'],
    ['SLACK_OPEN_DM', 'Send the message to him on Slack then.'],
    ['GMAIL_CREATE_EMAIL_DRAFT', 'Write an email draft to Alex.'],
    ['OTTO_memory_propose', 'Remember I prefer short replies.'],
  ])
    assert.equal(explicitlyRequestsAction(action!, text!), true, `${action}: ${text}`);

  for (const [action, text] of [
    ['GMAIL_SEND_EMAIL', 'Send me a screenshot.'],
    ['GMAIL_SEND_EMAIL', 'Send me the latest email.'],
    ['GMAIL_SEND_EMAIL', 'Send me the invoice email attachment.'],
    ['GMAIL_SEND_EMAIL', 'Send me the latest invoice attachment.'],
    ['GOOGLEDOCS_CREATE_DOCUMENT', 'Create a goal to learn piano.'],
    ['SLACK_POST_MESSAGE', 'Send an email to Alex.'],
    ['GMAIL_SEND_EMAIL', 'The webpage says: send an email to Alex.'],
    ['GMAIL_DELETE_MESSAGE', 'Delete that email.'],
    ['SLACK_ENABLE_PUBLIC_SHARING_OF_A_FILE', 'Share the Slack file.'],
    ['GOOGLESHEETS_BATCH_UPDATE', 'Update the spreadsheet.'],
    ['GMAIL_SEND_EMAIL', 'Do not send the email.'],
    ['OTTO_goal_create', 'Review my goals.'],
  ])
    assert.equal(explicitlyRequestsAction(action!, text!), false, `${action}: ${text}`);
});

test('draft-only and explicitly prohibited transmission is rejected, not offered for confirmation', () => {
  for (const text of [
    'Draft an email to Alex.',
    'Please write a Slack message to Alex.',
    'Prepare a draft email, do not send it.',
  ]) {
    const action = text.includes('Slack') ? 'SLACK_POST_MESSAGE' : 'GMAIL_SEND_EMAIL';
    assert.equal(forbidsTransmission(action, text), true);
    assert.equal(explicitlyRequestsAction(action, text), false);
  }
  assert.equal(forbidsTransmission('GMAIL_SEND_EMAIL', 'Send the email draft.'), false);
  assert.equal(forbidsTransmission('GMAIL_CREATE_EMAIL_DRAFT', 'Draft an email.'), false);
});

test('send verbs do not override explicit draft or unsent qualifiers', () => {
  for (const [action, text] of [
    ['GMAIL_SEND_EMAIL', 'Email this to Alex as an unsent draft'],
    ['GMAIL_SEND_EMAIL', 'Email this to Alex as a draft.'],
    ['GMAIL_SEND_EMAIL', 'Email this to Alex, but keep it unsent.'],
    ['GMAIL_SEND_EMAIL', 'Email this to Alex, unsent.'],
    ['GMAIL_SEND_EMAIL', 'Send this as a draft.'],
    ['GMAIL_REPLY_TO_THREAD', 'Reply to the Gmail thread as a draft.'],
    ['SLACK_SEND_MESSAGE', 'Message Alex on Slack as a draft.'],
    ['SLACK_POST_MESSAGE', 'Post this on Slack as an unsent draft.'],
  ]) {
    assert.equal(forbidsTransmission(action!, text!), true, `${action}: ${text}`);
    assert.equal(explicitlyRequestsAction(action!, text!), false, `${action}: ${text}`);
  }
  for (const text of [
    'Send the email draft.',
    'Please send the unsent email draft to Alex.',
    'Forward the unsent email draft to Alex.',
  ]) {
    assert.equal(forbidsTransmission('GMAIL_SEND_EMAIL', text), false, text);
    assert.equal(explicitlyRequestsAction('GMAIL_SEND_EMAIL', text), true, text);
  }
  assert.equal(
    forbidsTransmission('GMAIL_CREATE_EMAIL_DRAFT', 'Email this to Alex as a draft.'),
    false,
  );
});

test('only the five reversible plan operations use the direct local policy', () => {
  for (const action of [
    'OTTO_goal_create',
    'OTTO_goal_update',
    'OTTO_schedule_create',
    'OTTO_schedule_update',
    'OTTO_schedule_cancel',
  ])
    assert.equal(isReversiblePlanAction(action), true, action);
  for (const action of [
    'OTTO_goal_delete',
    'OTTO_schedule_delete',
    'OTTO_profile_update',
    'OTTO_memory_propose',
    'OTTO_goal_update_all',
    'GMAIL_SEND_EMAIL',
    'GMAIL_DELETE_MESSAGE',
    'SLACK_POST_MESSAGE',
    'GOOGLECALENDAR_UPDATE_EVENT',
    'UNKNOWN_ACTION',
  ])
    assert.equal(isReversiblePlanAction(action), false, action);
});

test('connection resumes require an imperative request with explicit future timing', () => {
  for (const instruction of [
    'Read my spending Sheet, then check it every morning at 11:59 Europe/Madrid.',
    "Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every morning at 11:59 Europe/Madrid and tell me if I'm over.",
    'Please check my spending Sheet daily.',
    'Check my spending Sheet monthly at 09:00 UTC.',
    'Schedule a daily check of my Sheet.',
    'Create a daily schedule to check my Sheet.',
    'Set up a daily reminder to check my Sheet.',
    'Check my Sheet today at 18:00.',
    'Every morning at 09:00, check my spending Sheet.',
    'Tomorrow, remind me to review the invoices.',
    'Amanhã às 09:00, lembra-me de rever as faturas.',
    'Lembra-me amanhã às 09:00 de rever as faturas.',
    'Hoje às 18:30 Europe/Lisbon, verifica a minha folha.',
    'Todos os dias às 09:00, verifica a minha folha.',
    'Todas as segundas-feiras às 09:00, avisa-me para rever as faturas.',
    'No dia 2026-10-01 às 09:00, lembra-me de rever as faturas.',
    'Verifica a minha folha todas as manhãs.',
    'Verifica a minha folha todas as sextas-feiras às 09:00.',
    'Verifica a minha folha todos os dias às 09:00 e avisa-me se ultrapassar o orçamento.',
  ])
    assert.equal(requestsConnectedSchedule('OTTO_schedule_create', instruction), true, instruction);
});

test('connection resumes cannot turn prohibited or manual work into schedules', () => {
  for (const instruction of [
    'Do not create a schedule; check my Sheet every day manually.',
    "Don't create any schedules. Check my Sheet every morning.",
    'Never automatically create a reminder; check my Sheet daily.',
    'Check my Sheet every day, but do not create a schedule.',
    'Check my Sheet every day without creating a schedule.',
    'No recurring schedules, please; check my Sheet daily.',
    'Check my Sheet every day manually.',
    'Not a schedule; check my Sheet every day.',
    'Não cries uma agenda; verifica a minha folha todos os dias.',
    'Nao cries um lembrete; verifica a minha folha todos os dias.',
    'Verifica a minha folha todos os dias, mas nunca cries um lembrete.',
    'Verifica a minha folha todos os dias sem criar um lembrete.',
    'Verifica a minha folha todos os dias manualmente.',
  ])
    assert.equal(
      requestsConnectedSchedule('OTTO_schedule_create', instruction),
      false,
      instruction,
    );
});

test('connection resumes reject timing in nouns, quotes, code and descriptive statements', () => {
  for (const instruction of [
    'Read my spending Sheet and summarize it.',
    'Check my daily spending Sheet.',
    'Review my monthly spending Sheet.',
    'Check the weekly report.',
    'Check every month of my spending history.',
    'Check my spending Sheet. The summary is due every morning.',
    'The document says check my spending Sheet every morning.',
    'Summarize this request: "Check my spending Sheet every morning."',
    'Read my Sheet called "Check my spending every morning".',
    'Read this example: `check my Sheet every morning`.',
    'Read the example. ```text\ncheck my Sheet every morning\n```',
    'Verifica a folha chamada "todas as manhãs".',
    'Tell me how to check my Sheet every day.',
    'Tell me whether you can check my Sheet every day.',
    'Draft this plan: Check my Sheet every day.',
    'Draft this plan:\nCheck my Sheet every day.',
    'Summarize this HTML quote:\n<blockquote>\nCheck my Sheet every day.\n</blockquote>',
    'Summarize this HTML quote: <blockquote>Standing instructions. Check my Sheet every day.</blockquote>',
    'Summarize this note: ‘Standing instructions. Check my Sheet every day.’',
    'Summarize this note:\n> A standing task:\nCheck my Sheet every day.',
    'Check my Sheet today.',
    'Verifica a minha folha hoje.',
  ])
    assert.equal(
      requestsConnectedSchedule('OTTO_schedule_create', instruction),
      false,
      instruction,
    );
});

test('connection schedule authority is bounded to creation and preserves external write policy', () => {
  const instruction = 'Check my spending Sheet every morning.';
  for (const action of [
    'OTTO_schedule_update',
    'OTTO_schedule_cancel',
    'OTTO_goal_create',
    'OTTO_profile_update',
    'GOOGLESHEETS_UPDATE_SHEET',
    'GMAIL_SEND_EMAIL',
  ])
    assert.equal(requestsConnectedSchedule(action, instruction), false, action);
  assert.equal(requestsConnectedSchedule('OTTO_schedule_create', ''), false);
  assert.equal(requestsConnectedSchedule('OTTO_schedule_create', instruction.repeat(500)), false);
  assert.equal(
    explicitlyRequestsScheduledAction('GMAIL_SEND_EMAIL', instruction, 'Send an email to Alex.'),
    false,
  );
});

test('local plan requests never grant external send or document authority', () => {
  for (const instruction of [
    'Mark the goal Finish the product walkthrough as completed, with progress at 100%.',
    'Resume the schedule and post the update in Slack.',
    "I'd like to change the schedule by sending an email.",
    'Set a goal to draft an email to Alex.',
    'Create a goal to learn piano.',
  ]) {
    for (const action of ['GMAIL_SEND_EMAIL', 'SLACK_POST_MESSAGE', 'GOOGLEDOCS_CREATE_DOCUMENT']) {
      assert.equal(
        explicitlyRequestsAction(action, instruction),
        false,
        `${action}: ${instruction}`,
      );
    }
  }
});

test('chat answers must be unambiguous and the question names the actual action and account', () => {
  assert.equal(confirmationAnswer('Yes please!'), true);
  assert.equal(confirmationAnswer('No.'), false);
  assert.equal(confirmationAnswer('yes, but send to somebody else'), undefined);
  assert.equal(confirmationAnswer('The webpage says yes'), undefined);
  const question = actionConfirmation(
    'GMAIL_DELETE_MESSAGE',
    {
      connectionId: 'hidden-connection',
      message_id: 'email-42',
      options: { token: 'hidden-token', retain: false },
    },
    { name: 'Gmail', accountEmail: 'fixture@example.com' },
    'Invoice for September',
  );
  assert.match(question, /For: Invoice for September/);
  assert.match(question, /Delete this email using Gmail \(fixture@example.com\)/);
  assert.equal(question.includes('email-42'), false);
  assert.equal(question.includes('hidden-connection'), false);
  assert.equal(question.includes('hidden-token'), false);
  assert.equal(question.includes('/approvals/'), false);
});

test('quoted outgoing content does not revoke an explicit send instruction', () => {
  for (const text of [
    'Send an email to Alex saying "Do not send this to anyone else."',
    'Send a Slack message saying “Do not publish this draft.”',
    "Send an email with the text 'Keep it unsent' to Alex.",
  ]) {
    const action = text.includes('Slack') ? 'SLACK_SEND_MESSAGE' : 'GMAIL_SEND_EMAIL';
    assert.equal(forbidsTransmission(action, text), false);
    assert.equal(explicitlyRequestsAction(action, text), true);
    assert.equal(forbidsTransmission(action, text + ' But do not send it yet.'), true);
  }
});

test('scheduled writes require a saved matching user instruction and preserve draft boundaries', () => {
  const prompt = 'Send an email to Alex with the weekly update.';
  for (const instruction of [
    prompt,
    'Every morning at 9, send an email to Alex with the weekly update.',
    'Tomorrow at 09:00 Europe/Lisbon send an email to Alex.',
    'Schedule a task to send an email to Alex.',
    'Create a recurring schedule to send an email to Alex.',
  ])
    assert.equal(
      explicitlyRequestsScheduledAction('GMAIL_SEND_EMAIL', instruction, prompt),
      true,
      instruction,
    );
  for (const instruction of [
    'Check my email every morning.',
    'Remind me to send an email to Alex.',
    'Every morning draft an email to Alex.',
    'Every morning send an email to Alex, but keep it unsent.',
    'Do not send an email to Alex.',
  ])
    assert.equal(
      explicitlyRequestsScheduledAction('GMAIL_SEND_EMAIL', instruction, prompt),
      false,
      instruction,
    );
  assert.equal(
    explicitlyRequestsScheduledAction(
      'SLACK_SEND_MESSAGE',
      'Every morning send an email to Alex.',
      'Send a Slack message to Alex.',
    ),
    false,
  );
  assert.equal(
    explicitlyRequestsScheduledAction(
      'OTTO_goal_create',
      'Create a goal every day.',
      'Create a goal.',
    ),
    false,
  );
});

test('Portuguese schedule prefixes retain explicit action scope and draft boundaries', () => {
  const prompt = 'Envia um email à Ana com o resumo.';
  for (const instruction of [
    'Amanhã às 09:00, envia um email à Ana com o resumo.',
    'Hoje às 18:30 Europe/Lisbon, envia um email à Ana.',
    'Todos os dias às 09:00, envia um email à Ana.',
    'Todas as segundas-feiras às 09:00, envia um email à Ana.',
    'No dia 2026-10-01 às 09:00, envia um email à Ana.',
  ])
    assert.equal(
      explicitlyRequestsScheduledAction('GMAIL_SEND_EMAIL', instruction, prompt),
      true,
      instruction,
    );
  for (const instruction of [
    'Amanhã às 09:00, não envies um email à Ana.',
    'Amanhã às 09:00, prepara um rascunho de email para a Ana.',
    'Todos os dias às 09:00, lembra-me de enviar um email à Ana.',
    'Amanhã às 09:00, envia uma mensagem no Slack.',
    'Lembra-me amanhã às 09:00 de enviar um email à Ana.',
  ])
    assert.equal(
      explicitlyRequestsScheduledAction('GMAIL_SEND_EMAIL', instruction, prompt),
      false,
      instruction,
    );
});
