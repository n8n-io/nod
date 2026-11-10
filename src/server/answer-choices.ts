import { laterSupersedingTurnSql } from './turn-chain.ts';

export const pendingAnswerChoicesSql = `m.role='assistant' AND m.answer_choices IS NOT NULL AND EXISTS (
  SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id
  WHERE u.id=m.turn_id AND u.owner_id=m.owner_id AND u.thread_id=m.thread_id AND th.archived_at IS NULL
    AND u.status='waiting' AND u.waiting_reason='question' AND u.handoff_browser_id IS NULL
    AND m.id=(SELECT q.id FROM messages q WHERE q.turn_id=u.id AND q.owner_id=u.owner_id AND q.role='assistant'
      ORDER BY q.created_at DESC,q.id DESC LIMIT 1)
    AND NOT ${laterSupersedingTurnSql})`;
