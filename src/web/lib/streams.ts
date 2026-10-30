interface StreamState {
  threadId: string;
  active: Record<string, { turnId: string; text: string }>;
  completed: string[];
}

export type StreamAction =
  | {
      type: 'delta';
      turnId: string;
      text: string;
      streamId?: string;
      done?: boolean;
      threadId?: string;
    }
  | {
      type: 'persisted';
      streamIds: string[];
      discardedTurnIds?: string[];
      threadId?: string;
    }
  | { type: 'thread'; threadId: string };

export const initialStreamState: StreamState = {
  threadId: '',
  active: {},
  completed: [],
};
const completedStreamLimit = 512;

function closeStreams(state: StreamState, ids: string[]): StreamState {
  if (!ids.length) return state;
  const closed = new Set(ids);
  const completed = [...state.completed.filter((id) => !closed.has(id)), ...closed].slice(
    -completedStreamLimit,
  );
  const active = Object.fromEntries(Object.entries(state.active).filter(([id]) => !closed.has(id)));
  return { ...state, active, completed };
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  const threadId = action.threadId ?? state.threadId;
  if (threadId !== state.threadId) {
    if (action.type === 'delta' && state.threadId) return state;
    state = { threadId, active: {}, completed: [] };
  }
  if (action.type === 'thread') return state;
  if (action.type === 'persisted') {
    const discarded = new Set(action.discardedTurnIds ?? []);
    return closeStreams(state, [
      ...action.streamIds,
      ...Object.entries(state.active)
        .filter(([, stream]) => discarded.has(stream.turnId))
        .map(([id]) => id),
    ]);
  }
  const id = action.streamId || `turn:${action.turnId}`;
  if (action.done) return closeStreams(state, [id]);
  if (!action.text || state.completed.includes(id)) return state;
  const current = state.active[id];
  if (current && current.turnId !== action.turnId) return state;
  return {
    ...state,
    active: {
      ...state.active,
      [id]: { turnId: action.turnId, text: (current?.text ?? '') + action.text },
    },
  };
}
