import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Message, MessageHistoryPage } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { Button, Notice } from '../components/ui';
import { ChatTop, BotEmpty } from '../components/bots';
import { ChatBot, type Bot } from '../lib/bots';
import { Chat } from './chat';

export function BotChat({
  bot,
  ownerId,
  state,
  streams,
  connected,
  refresh,
  visible,
  onNavigate,
  onRead,
  onFeedback,
  focusMessageId,
}: {
  bot: Bot;
  ownerId: string;
  state: AppState;
  streams: Record<string, string>;
  connected?: boolean;
  refresh(): Promise<void>;
  visible: boolean;
  onNavigate(path: string): void;
  onRead(chatId: string, at: string): void;
  onFeedback?(): void;
  focusMessageId?: string;
}) {
  const [page, setPage] = useState<MessageHistoryPage | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const request = useRef(0);
  const chatTurns = state.turns.filter((turn) => turn.botId === bot.id);
  const version = `${chatTurns.map((turn) => `${turn.id}${turn.status}`).join()}:${bot.status}:${bot.latestReply?.id ?? ''}:${bot.lastMessage?.text ?? ''}:${bot.question ?? ''}`;
  useEffect(() => {
    const current = ++request.current;
    void api<MessageHistoryPage>(`/api/bots/${bot.id}/messages`)
      .then((next) => {
        if (request.current !== current) return;
        setPage(next);
        setFailure('');
      })
      .catch((cause) => {
        if (request.current === current) setFailure(errorMessage(cause));
      });
  }, [bot.id, version, attempt]);
  const latest = page?.messages.at(-1)?.createdAt;
  useEffect(() => {
    if (visible && latest) onRead(bot.id, latest);
  }, [visible, latest, bot.id]);
  useEffect(() => {
    if (!visible) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const busy = [
        ...document.querySelectorAll(
          '[role="dialog"],[role="menu"],.artifact-drawer,.bot-chat-route :is(.composer-reply,.composer.has-recording),#bot-panel:not(.bot-panel-closing)',
        ),
      ].some((element) => element.getClientRects().length);
      if (busy) return;
      const editor = document.querySelector('.bot-chat-route .composer-editor');
      if (editor?.textContent?.trim()) return;
      onNavigate('/');
    };
    window.addEventListener('keydown', leave, true);
    return () => window.removeEventListener('keydown', leave, true);
  }, [visible, onNavigate]);
  const turnIds = new Set(
    (state.activity ?? []).filter((item) => item.botId === bot.id).map((item) => item.turnId),
  );
  const scoped = useMemo<AppState>(
    () => ({
      ...state,
      messages: page?.messages ?? ([] as Message[]),
      turns: state.turns.filter((turn) => turn.botId === bot.id),
      hasEarlierMessages: page?.hasMore ?? false,
      hiddenMessageCount: 0,
      hiddenMessageIds: [],
      chatRecovery: undefined,
      planningTasks: false,
      tasks: state.tasks?.filter((task) => task.botId === bot.id),
      verificationRequests: state.verificationRequests?.filter(
        (request) => request.botId === bot.id,
      ),
      activity: state.activity?.filter((item) => item.botId === bot.id),
    }),
    [state, page, bot.id],
  );
  const chatStreams = Object.fromEntries(
    Object.entries(streams).filter(([id]) =>
      [...turnIds].some((turnId) => id === `turn:${turnId}` || id.includes(turnId)),
    ),
  );
  return (
    <div className="bot-chat-route chat-surface">
      <ChatTop bot={bot} toolsRef={setTools} />
      {!page && failure && (
        <div className="initial-loading">
          <Notice>{failure}</Notice>
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      )}
      {page && (
        <ChatBot.Provider value={bot.id}>
          <Chat
            key={bot.id}
            chat={bot}
            ownerId={ownerId}
            state={scoped}
            streams={chatStreams}
            connected={connected}
            refresh={refresh}
            visible={visible}
            toolbarActions={tools}
            readUnavailable
            initialFocusMessageId={focusMessageId}
            onFeedback={onFeedback}
            empty={<BotEmpty bot={bot} />}
          />
        </ChatBot.Provider>
      )}
    </div>
  );
}
