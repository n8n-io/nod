import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from '../../../src/web/pages/chat';
import type { AppState, Artifact, Message } from '../../../src/shared/contracts';
import '../../../src/web/styles.css';
import '../../../src/web/theme.css';
import '../../../src/web/pages/chat.css';
import '../../../src/web/pages/tasks.css';
import '../../../src/web/components/message-actions.css';
import '../../../src/web/components/composer.css';
import '../../../src/web/components/editor-formatting.css';
import '../../../src/web/components/private-entry.css';
import '../../../src/web/components/attachment-images.css';
import '../../../src/web/components/attachment-card.css';
import '../../../src/web/components/artifact-drawer.css';
import '../../../src/web/components/telegram-chat-link.css';

const turnId = '12345678-1234-1234-1234-123456789abc';
const threadId = '12345678-1234-1234-1234-123456789abd';
const reference =
  'https://example.com/__trip_notes__?day[]=sat&day[]=sun&next=%26copy%3B#route_two';
const literalNotes = 'C:\\trips\\weekend_notes.md\n<tag> &copy; [] () 🙂';
const input = `${reference}\n\nKeep these notes exactly:\n\n\`\`\`text\n${literalNotes}\n\`\`\``;
const note = `# A relaxed weekend\n\n## Saturday\n\nMuseum → lunch nearby → a short walk.\n\n## Sunday\n\nMarket → coffee → a free afternoon.\n\n## Reference\n\n<${reference}>\n\n## Literal notes\n\n\`\`\`text\nC:\\trips\\weekend_notes.md\n<tag> &copy; [] () 🙂\n\`\`\``;
const artifact: Artifact = {
  id: '12345678-1234-1234-1234-123456789abe',
  name: 'weekend_notes.md',
  mimeType: 'text/markdown',
  size: new TextEncoder().encode(note).byteLength,
  url: '/api/artifacts/12345678-1234-1234-1234-123456789abe',
};
const demo = {
  reference,
  input,
  literalNotes,
  note,
  artifact,
  sent: [] as string[],
  requests: [] as string[],
  trace: [] as Array<{ at: number; text: string }>,
  accept(_id: string, _text: string) {},
  say(_text: string, _attachments: Artifact[] = []) {},
  work(_step: string | null) {},
  caption(_text: string) {},
};
Object.assign(window, { cadence: demo });
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    window.location.href,
  );
  demo.requests.push(url.pathname);
  if (url.pathname === '/api/messages') {
    const body = JSON.parse(String(init?.body));
    demo.sent.push(body.text);
    demo.accept(body.clientMessageId, body.text);
    return json({ threadId, turnId, messageId: body.clientMessageId, messageText: body.text });
  }
  if (url.pathname === artifact.url)
    return new Response(note, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  if (url.pathname === '/api/apps') return json([]);
  if (url.pathname === '/api/link-preview') return json({ preview: null });
  return json({});
};
let sequence = 0;
function message(role: Message['role'], text: string, attachments: Artifact[] = []): Message {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    attachments,
    turnId,
    createdAt: new Date(Date.now() + sequence++).toISOString(),
  };
}
const initial: AppState = {
  threadId,
  messages: [
    message(
      'user',
      'Make me a relaxed weekend plan: a museum on Saturday, a market on Sunday, and short walks. I’ll paste the reference.',
    ),
  ],
  turns: [],
  activity: [],
  configuration: {
    provider: 'synthetic',
    model: 'scripted-demo',
    llmReady: true,
    modelReconnect: false,
    integrationsReady: false,
    conversationResetEnabled: false,
  },
};
function Cadence() {
  const [state, setState] = useState(initial);
  const [caption, setCaption] = useState('Activity stays visible. Useful results arrive in chat.');
  demo.accept = (id, text) =>
    setState((current) => ({
      ...current,
      messages: [...current.messages, { ...message('user', text), id }],
      turns: [
        { id: turnId, status: 'running', source: 'user', createdAt: new Date().toISOString() },
      ],
    }));
  demo.say = (text, attachments = []) => {
    demo.trace.push({ at: Date.now(), text });
    setState((current) => ({
      ...current,
      messages: [...current.messages, message('assistant', text, attachments)],
    }));
  };
  demo.work = (step) =>
    setState((current) => ({
      ...current,
      activity: step
        ? [{ turnId, taskId: null, title: null, step, site: null, since: new Date().toISOString() }]
        : [],
      turns: current.turns.map((turn) => ({ ...turn, status: step ? 'running' : 'succeeded' })),
    }));
  demo.caption = setCaption;
  return (
    <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '18px 40px 12px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Helpful progress. Clear text.</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
          Scripted assistant · Real chat, activity and file preview
        </p>
        <p data-demo-caption style={{ fontSize: 14, marginTop: 10 }}>
          {caption}
        </p>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Chat
          ownerId="synthetic-cadence-review"
          state={state}
          streams={{}}
          refresh={async () => {}}
          resetConversation={async () => threadId}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Cadence />);
