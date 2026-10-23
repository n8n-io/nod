import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../src/web/components/composer';
import { FeedbackEditor } from '../../../src/web/components/feedback-editor';
import { MessageText } from '../../../src/web/components/message';
import '../../../src/web/styles.css';
import '../../../src/web/pages/chat.css';
import '../../../src/web/theme.css';
import '../../../src/web/components/composer.css';
import '../../../src/web/components/message-actions.css';
import '../../../src/web/components/feedback.css';
import '../../../src/web/components/editor-formatting.css';

window.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
const review = { sent: [] as string[], feedback: '', fail: true };
Object.assign(window, { review });

function Review() {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  return (
    <main
      className="chat-page"
      style={{ maxWidth: 860, margin: '20px auto', padding: 24, height: 'auto', display: 'block' }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Clear text. Correct links.</h1>
      <p data-demo-caption style={{ color: 'var(--muted-foreground)', margin: '8px 0 24px' }}>
        Synthetic review with the app’s chat and feedback editors.
      </p>
      <div className="message message-assistant" style={{ margin: '20px 0' }}>
        <div className="message-bubble">
          <div className="message-body">
            <MessageText
              previews={false}
              text={
                'Set up a weekday inbox check?\n\nI’ll check your work inbox at **08:00 Europe/Berlin**, Monday to Friday, and send you one summary of invoices and security alerts.\n\nI’ll stay quiet when there’s nothing to flag.'
              }
            />
          </div>
        </div>
      </div>
      {sent.map((value, index) => (
        <div key={index} className="message message-user" style={{ margin: '20px 0' }}>
          <div className="message-bubble">
            <div className="message-body">
              <MessageText text={value} previews={false} />
            </div>
          </div>
        </div>
      ))}
      <Composer
        ready
        text={text}
        setText={setText}
        replyTo={null}
        clearReply={() => {}}
        onSend={async (value) => {
          review.sent.push(value);
          if (review.fail) {
            review.fail = false;
            return { sent: false, restoreText: true };
          }
          setSent((messages) => [...messages, value]);
          return { sent: true };
        }}
      />
      <h2 style={{ margin: '28px 0 12px' }}>Feedback</h2>
      <FeedbackEditor
        value={feedback}
        onChange={(value) => {
          review.feedback = value;
          setFeedback(value);
        }}
        placeholder="Write feedback…"
        disabled={false}
        onSubmit={() => {}}
        onUpload={() => {}}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Review />);
