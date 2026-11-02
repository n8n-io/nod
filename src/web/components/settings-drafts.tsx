import { createContext, useContext, useEffect, useRef, useState } from 'react';

export interface SettingsChange {
  label: string;
  before: string;
  after: string;
}

export interface SettingsDraft {
  changes: SettingsChange[];
  busy: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}

export interface RegisteredSettingsDraft extends SettingsDraft {
  id: string;
  revision: symbol;
}

type RegisterDraft = (draft: RegisteredSettingsDraft) => () => void;

export const SettingsDraftContext = createContext<RegisterDraft | null>(null);

export function useSettingsDraft(id: string, draft: SettingsDraft) {
  const register = useContext(SettingsDraftContext);
  const latest = useRef(draft);
  latest.current = draft;
  const signature = JSON.stringify({ changes: draft.changes, busy: draft.busy });

  useEffect(() => {
    if (!register || (!latest.current.changes.length && !latest.current.busy)) return;
    return register({
      id,
      revision: Symbol(id),
      changes: latest.current.changes,
      busy: latest.current.busy,
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
    });
  }, [register, id, signature]);
}

export function useSettingsDrafts() {
  const [drafts, setDrafts] = useState<RegisteredSettingsDraft[]>([]);
  const [register] = useState<RegisterDraft>(() => (draft: RegisteredSettingsDraft) => {
    setDrafts((current) => [...current.filter((entry) => entry.id !== draft.id), draft]);
    return () => {
      setDrafts((current) => current.filter((entry) => entry.revision !== draft.revision));
    };
  });
  return { drafts, register };
}
