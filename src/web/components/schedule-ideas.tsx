import { useState } from 'react';
import type { Connection } from '../../shared/contracts';
import { integrationServices } from '../../shared/integrations';
import { usePageData } from '../hooks/use-page-data';
import { ServiceLogo } from './service-logo';

type Idea = { title: string; when: string; app?: string };

const ideas: Idea[] = [
  { title: 'Remind me to plan my week', when: 'Fridays' },
  { title: 'Recap what we worked on this week', when: 'Fridays' },
  { title: 'Send me a short news brief on my industry', when: 'Weekdays' },
  { title: 'Watch a product’s price and tell me when it drops', when: 'Every day' },
  { title: 'Remind me to send my invoices', when: 'Every month' },
  { title: 'Check my competitors’ websites for news', when: 'Every week' },
  { title: 'Brief me on my day', when: 'Weekday mornings', app: 'googlecalendar' },
  { title: 'Brief me on tomorrow’s meetings', when: 'Every evening', app: 'googlecalendar' },
  { title: 'Show me my week and my free time', when: 'Mondays', app: 'googlecalendar' },
  { title: 'Prepare me for my next meeting', when: 'Every hour', app: 'googlecalendar' },
  { title: 'List the emails that need my reply', when: 'Weekdays', app: 'gmail' },
  { title: 'Summarize today’s important email', when: 'Every evening', app: 'gmail' },
  { title: 'Summarize the Slack threads that mention me', when: 'Every evening', app: 'slack' },
  { title: 'Remind me what’s still open in Notion', when: 'Fridays', app: 'notion' },
  { title: 'Sum up what moved in my Linear issues', when: 'Weekdays', app: 'linear' },
  { title: 'List the Outlook emails that need my reply', when: 'Weekdays', app: 'outlook' },
];
const invitations = ['googlecalendar', 'gmail', 'slack', 'notion', 'linear'];

function shuffled<T>(items: T[]) {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [list[index], list[other]] = [list[other]!, list[index]!];
  }
  return list;
}

export function ScheduleIdeas({ first, onAsk }: { first: boolean; onAsk(text: string): void }) {
  const { data: connections } = usePageData<Connection[]>('/api/apps');
  const { data: personal, loading } = usePageData<{ ideas: Idea[] }>('/api/schedules/ideas');
  const [order] = useState(() => shuffled(ideas));
  const connected = new Set(
    (connections ?? []).filter((item) => item.status === 'connected').map((item) => item.slug),
  );
  const missing = connections && invitations.find((app) => !connected.has(app));
  const invite = missing ? order.find((idea) => idea.app === missing) : undefined;
  const mined = (personal?.ideas ?? [])
    .filter(
      (idea) =>
        (!idea.app || connected.has(idea.app)) &&
        idea.title.toLowerCase() !== invite?.title.toLowerCase(),
    )
    .slice(0, 2);
  const titles = new Set(mined.map((idea) => idea.title.toLowerCase()));
  const fixed = order.filter((idea) => !titles.has(idea.title.toLowerCase()));
  const shown = [
    ...mined,
    ...fixed
      .filter((idea) => !idea.app || connected.has(idea.app))
      .sort((a, b) => Number(Boolean(b.app)) - Number(Boolean(a.app)))
      .slice(0, (invite ? 2 : 3) - mined.length),
    ...(invite ? [invite] : []),
  ];
  if (loading && !personal) return null;
  return (
    <section className="schedule-ideas" aria-labelledby="schedule-ideas-title">
      <h2 id="schedule-ideas-title">
        {first ? 'Or start from an idea' : 'Ideas for another schedule'}
      </h2>
      <div className="task-cards">
        {shown.map((idea) => {
          const app = idea.app && !connected.has(idea.app) ? idea.app : undefined;
          const name = app ? (integrationServices[app]?.name ?? app) : '';
          return (
            <button
              key={idea.title}
              type="button"
              className="task-card"
              onClick={() =>
                onAsk(
                  `${app ? `Help me connect ${name} and schedule this` : 'Help me schedule this'}: ${idea.title}, ${idea.when.toLowerCase()}. Ask me one question at a time for anything you need.`,
                )
              }
            >
              <span className="task-title">{idea.title}</span>
              <span className="task-meta">
                {idea.app && <ServiceLogo slug={idea.app} size={16} />}
                <span>{app ? `${idea.when} · Connect ${name}` : idea.when}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
