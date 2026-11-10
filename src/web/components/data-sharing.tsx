import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  ChartColumn,
  LockKeyhole,
  MessageSquareText,
  type IconComponent,
} from './icons';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './ui';

const detailsUrl = 'https://nod.n8n.io/docs/trust/privacy/#what-nod-shares-with-n8n';

function Item({
  icon: Icon,
  title,
  state,
  children,
}: {
  icon: IconComponent;
  title: string;
  state?: string;
  children: ReactNode;
}) {
  return (
    <li>
      <Icon size={20} aria-hidden="true" />
      <div>
        <p className="data-sharing-title">
          <strong>{title}</strong>
          {state && <span>{state}</span>}
        </p>
        <p>{children}</p>
      </div>
    </li>
  );
}

const state = (on: boolean) => (on ? 'On' : 'Off');

export function DataSharing({
  usage,
  traces,
  className,
}: {
  usage?: boolean;
  traces?: boolean;
  className?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={className}>
          How Nod uses your data
        </button>
      </DialogTrigger>
      <DialogContent className="data-sharing">
        <DialogTitle>How Nod uses your data</DialogTitle>
        <DialogDescription>
          A little data shows the Nod team at n8n where Nod gets stuck, so they can make it better.
        </DialogDescription>
        <ul>
          {usage !== undefined && (
            <Item icon={ChartColumn} title="Usage data" state={state(usage)}>
              Which screens and features you use, the kinds of tasks you ask for, what fails, your
              onboarding and survey answers, and your email (if you provide it). Never your
              messages.
            </Item>
          )}
          {traces !== undefined && (
            <Item icon={MessageSquareText} title="Conversation traces" state={state(traces)}>
              Your chats with Nod, after it removes the personal details it can recognize. It can
              miss some. Deleted after 14 days and never used to train AI.
            </Item>
          )}
          <Item icon={LockKeyhole} title="Never shared">
            Saved passwords and cards, your memory, or screen recordings.
          </Item>
        </ul>
        <p>
          Stored in the EU. Turning a switch off stops new data of that kind; ask us to delete
          earlier data.
        </p>
        <div className="data-sharing-actions">
          <a href={detailsUrl} target="_blank" rel="noreferrer">
            Full details <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <DialogClose asChild>
            <Button>Got it</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
