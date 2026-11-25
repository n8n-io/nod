import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../shared/contracts';
import { taskLabels } from '../../shared/task-status';
import { api, errorMessage } from '../lib/api';
import { captureAnalytics } from '../lib/analytics';
import { ActionMenu, ActionMenuItem } from './action-menu';
import { Ellipsis, MessageCircle, Plus } from './icons';
import { Button, Input, Notice } from './ui';

const groups = [
  { label: 'Working', statuses: ['queued', 'working', 'waiting', 'scheduled'] },
  { label: 'Needs you', statuses: ['needs_you', 'failed'] },
  { label: 'Done', statuses: ['done', 'cancelled'] },
] as const;

export function ChatList({
  tasks,
  chat,
  fresh,
  unread,
  onChat,
  onNewChat,
  refresh,
}: {
  tasks: Task[];
  chat?: string;
  fresh: boolean;
  unread: Record<string, number>;
  onChat(id?: string): void;
  onNewChat(): void;
  refresh(): Promise<void>;
}) {
  const [closing, setClosing] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const saving = useRef(new Set<string>());
  const editing = useRef<string | undefined>(undefined);
  const renameNext = useRef<Task | undefined>(undefined);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const renamed = useRef<string | undefined>(undefined);
  const open = tasks.filter((task) => !task.archivedAt);
  useEffect(() => {
    if (renaming || !renamed.current) return;
    items.current.get(renamed.current)?.focus({ preventScroll: true });
    renamed.current = undefined;
  }, [renaming]);
  function startRename(task: Task) {
    setError('');
    setDraft(task.title);
    editing.current = task.id;
    setRenaming(task.id);
  }
  function stopRename(task: Task, refocus: boolean) {
    if (editing.current !== task.id) return;
    editing.current = undefined;
    if (refocus) renamed.current = task.id;
    setRenaming(undefined);
  }
  async function rename(task: Task, refocus: boolean) {
    if (saving.current.has(task.id) || editing.current !== task.id) return;
    const title = draft.trim();
    if (!title || title === task.title) return stopRename(task, refocus);
    saving.current.add(task.id);
    setError('');
    try {
      await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      });
      captureAnalytics('task_action', { action: 'rename_chat' });
      await refresh();
      stopRename(task, refocus);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      saving.current.delete(task.id);
    }
  }
  async function close(task: Task) {
    setClosing(task.id);
    setError('');
    try {
      await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      });
      captureAnalytics('task_action', { action: 'close_chat' });
      if (chat === task.id) onChat();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setClosing(undefined);
    }
  }
  return (
    <nav className="chat-list" aria-label="Chats">
      <Button
        variant="outline"
        size="sm"
        className="chat-list-new"
        aria-current={fresh ? 'page' : undefined}
        onClick={onNewChat}
      >
        <Plus size={16} aria-hidden="true" />
        New chat
      </Button>
      <button
        type="button"
        className="chat-list-item"
        aria-current={!chat && !fresh ? 'page' : undefined}
        onClick={() => onChat()}
      >
        <MessageCircle size={16} aria-hidden="true" />
        <span className="chat-list-title">Main</span>
      </button>
      {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
      {groups.map((group) => {
        const shown = open.filter((task) =>
          (group.statuses as readonly string[]).includes(task.status),
        );
        if (!shown.length) return null;
        return (
          <section key={group.label} className="chat-list-group" aria-label={group.label}>
            <h2>{group.label}</h2>
            <ul role="list">
              {shown.map((task) => (
                <li key={task.id} className="chat-list-row">
                  {renaming === task.id ? (
                    <form
                      className="chat-list-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void rename(task, true);
                      }}
                    >
                      <Input
                        autoFocus
                        value={draft}
                        maxLength={160}
                        aria-label={`Rename ${task.title}`}
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => void rename(task, false)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') return;
                          event.preventDefault();
                          stopRename(task, true);
                        }}
                      />
                    </form>
                  ) : (
                    <button
                      ref={(node) => {
                        if (node) items.current.set(task.id, node);
                        else items.current.delete(task.id);
                      }}
                      type="button"
                      className="chat-list-item"
                      aria-current={chat === task.id ? 'page' : undefined}
                      aria-keyshortcuts="F2"
                      onClick={() => {
                        captureAnalytics('task_action', { action: 'open_chat' });
                        onChat(task.id);
                      }}
                      onDoubleClick={() => startRename(task)}
                      onKeyDown={(event) => {
                        if (event.key !== 'F2') return;
                        event.preventDefault();
                        startRename(task);
                      }}
                    >
                      <span
                        className="chat-list-dot"
                        data-status={task.status}
                        aria-hidden="true"
                      />
                      <span className="chat-list-title">{task.title}</span>
                      <span className="sr-only">, {taskLabels[task.status]}</span>
                      {Boolean(unread[task.id]) && chat !== task.id && (
                        <span className="chat-list-unread">
                          {unread[task.id]! > 99 ? '99+' : unread[task.id]}
                          <span className="sr-only"> unread</span>
                        </span>
                      )}
                    </button>
                  )}
                  <ActionMenu
                    label={`Options for ${task.title}`}
                    className="chat-list-more"
                    contentClassName="action-menu-compact"
                    trigger={
                      <Button variant="ghost" size="icon" title="Chat options">
                        <Ellipsis size={16} aria-hidden="true" />
                      </Button>
                    }
                    onCloseAutoFocus={(event) => {
                      const next = renameNext.current;
                      if (!next) return;
                      renameNext.current = undefined;
                      event.preventDefault();
                      startRename(next);
                    }}
                  >
                    {(closeMenu) => (
                      <>
                        <ActionMenuItem
                          onClick={() => {
                            renameNext.current = task;
                            closeMenu();
                          }}
                        >
                          Rename
                        </ActionMenuItem>
                        {group.label === 'Done' && (
                          <ActionMenuItem
                            disabled={closing === task.id}
                            onClick={() => {
                              closeMenu();
                              void close(task);
                            }}
                          >
                            Close chat
                          </ActionMenuItem>
                        )}
                      </>
                    )}
                  </ActionMenu>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
