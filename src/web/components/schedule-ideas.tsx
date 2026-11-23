import { useState } from 'react';
import type { Connection } from '../../shared/contracts';
import { usePageData } from '../hooks/use-page-data';
import { ServiceLogo } from './service-logo';

const ideas: Array<{ title: string; when: string; app?: string }> = [
  { title: 'Send me a short news brief on my industry', when: 'Weekdays' },
  { title: 'Remind me to plan my week', when: 'Fridays' },
  { title: 'Find three articles worth reading in my field', when: 'Mondays' },
  { title: 'Watch a product’s price and tell me when it drops', when: 'Every day' },
  { title: 'Check my competitors’ websites for news', when: 'Every week' },
  { title: 'Remind me to send my invoices', when: 'Every month' },
  { title: 'List the emails that need my reply', when: 'Weekdays', app: 'gmail' },
  { title: 'Summarize today’s important email', when: 'Every evening', app: 'gmail' },
  { title: 'Brief me on tomorrow’s meetings', when: 'Every evening', app: 'googlecalendar' },
  { title: 'Show me my week and my free time', when: 'Mondays', app: 'googlecalendar' },
  { title: 'Sum up what moved in my Linear issues', when: 'Weekdays', app: 'linear' },
  { title: 'Summarize the Slack threads that mention me', when: 'Every evening', app: 'slack' },
  { title: 'Remind me what’s still open in Notion', when: 'Fridays', app: 'notion' },
  { title: 'List the Outlook emails that need my reply', when: 'Weekdays', app: 'outlook' },
];

export function ScheduleIdeas({ first, onAsk }: { first: boolean; onAsk(text: string): void }) {
  const { data: connections } = usePageData<Connection[]>('/api/apps');
  const [order] = useState(() => [...ideas].sort(() => Math.random() - 0.5));
  const connected = new Set(
    (connections ?? []).filter((item) => item.status === 'connected').map((item) => item.slug),
  );
  const shown = order
    .filter((idea) => !idea.app || connected.has(idea.app))
    .sort((a, b) => Number(Boolean(b.app)) - Number(Boolean(a.app)))
    .slice(0, 3);
  return (
    <section className="schedule-ideas" aria-labelledby="schedule-ideas-title">
      <h2 id="schedule-ideas-title">
        {first ? 'Or start from an idea' : 'Ideas for another schedule'}
      </h2>
      <div className="task-cards">
        {shown.map((idea) => (
          <button
            key={idea.title}
            type="button"
            className="task-card"
            onClick={() =>
              onAsk(
                `Help me schedule this: ${idea.title}, ${idea.when.toLowerCase()}. Ask me one question at a time for anything you need.`,
              )
            }
          >
            <span className="task-title">{idea.title}</span>
            <span className="task-meta">
              {idea.app && <ServiceLogo slug={idea.app} size={16} />}
              <span>{idea.when}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
