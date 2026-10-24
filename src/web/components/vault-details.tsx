import { useEffect, useId, useRef, useState } from 'react';
import { Copy, Eye, EyeOff } from './icons';
import type {
  VaultEntry,
  VaultEntryDetails,
  VaultEntryPassword,
  VaultCardNumber,
  VaultListEntry,
} from '../../shared/contracts';
import { api } from '../lib/api';
import { originLabel, suggestLoginName } from '../lib/vault-name';
import {
  clearVaultSecret,
  formatCardExpiry,
  parseCardExpiry,
  VaultFields,
  type VaultSecretName,
} from './vault-item-form';
import { VaultBackButton, VaultEntryIcon, VaultSurface, VaultTitle } from './vault-surface';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Loading,
  Notice,
} from './ui';

function hasChanges(form: HTMLFormElement, details: VaultEntryDetails) {
  const data = new FormData(form);
  if (String(data.get('label') ?? '') !== details.label) return true;
  if (
    String(data.get('cardNumber') ?? '').trim() ||
    Boolean(data.get('password')) ||
    String(data.get('authenticatorKey') ?? '').trim() ||
    data.get('removeAuthenticator')
  )
    return true;
  if (details.kind === 'login') return String(data.get('username') ?? '') !== details.username;
  const expiry = parseCardExpiry(data.get('expiry'));
  return (
    String(data.get('cardholder') ?? '') !== details.cardholder ||
    expiry?.expiryMonth !== details.expiryMonth ||
    expiry?.expiryYear !== details.expiryYear
  );
}

export function VaultDetails({
  entry,
  autoFocus,
  backLabel,
  onClose,
  onSaved,
  onDeleted,
  visible = true,
  children,
}: {
  entry: VaultEntry;
  visible?: boolean;
  autoFocus?: boolean;
  backLabel: string;
  onClose(): void;
  onSaved(entry: VaultListEntry): void;
  onDeleted(id: string): void;
  children?: React.ReactNode | ((details: VaultEntryDetails) => React.ReactNode);
}) {
  const [details, setDetails] = useState<VaultEntryDetails | null>(null);
  const [detailsError, setDetailsError] = useState(false);
  const [secrets, setSecrets] = useState<Partial<Record<VaultSecretName, string>>>({});
  const [busy, setBusy] = useState<{
    action: 'identity' | 'show' | 'copy';
    name?: VaultSecretName;
  } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const formId = useId();
  const bar = useRef<HTMLDivElement>(null);
  const editForm = useRef<HTMLFormElement>(null);
  const editField = useRef('label');
  const footer = useRef<HTMLDivElement>(null);
  const previousDeleting = useRef(deleting);
  const active = useRef(false);
  const detailsRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const actionGeneration = useRef(0);
  const isCard = entry.kind === 'card';
  const unreadable = 'unreadable' in entry && entry.unreadable === true;
  const item = isCard ? 'card' : 'login';
  const identityName =
    details?.kind === 'login'
      ? (details.identifierLabel ?? 'Username or email')
      : isCard
        ? 'Cardholder name'
        : 'Username or email';

  function cancelAction() {
    actionGeneration.current += 1;
    actionRequest.current?.abort();
    actionRequest.current = null;
  }

  function hideRevealed() {
    cancelAction();
    setSecrets({});
    setBusy(null);
    setError('');
    setNotice('');
  }

  function hideSecrets() {
    hideRevealed();
    clearVaultSecret(editForm.current);
    updateDirty();
  }

  function updateDirty() {
    if (details && editForm.current && !saving) setDirty(hasChanges(editForm.current, details));
  }

  const hideSecretsRef = useRef(hideSecrets);
  hideSecretsRef.current = hideSecrets;

  useEffect(() => {
    if (!visible) hideRevealed();
  }, [visible]);

  async function loadDetails() {
    detailsRequest.current?.abort();
    const request = new AbortController();
    detailsRequest.current = request;
    setDetailsError(false);
    try {
      const value = await api<VaultEntryDetails>(
        `/api/vault/${encodeURIComponent(entry.id)}/details`,
        { method: 'POST', body: '{}', cache: 'no-store', signal: request.signal },
      );
      if (!active.current || request.signal.aborted || detailsRequest.current !== request) return;
      if (value.id !== entry.id || value.kind !== entry.kind) throw new Error('Unexpected item');
      setDetails(value);
    } catch {
      if (active.current && !request.signal.aborted && detailsRequest.current === request)
        setDetailsError(true);
    }
  }

  useEffect(() => {
    active.current = true;
    if (unreadable) setDetailsError(true);
    else void loadDetails();
    const clear = () => hideSecretsRef.current();
    const hidden = () => {
      if (document.hidden) clear();
    };
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      active.current = false;
      detailsRequest.current?.abort();
      saveRequest.current?.abort();
      cancelAction();
      clearVaultSecret(editForm.current);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [entry.id]);

  useEffect(() => {
    if (previousDeleting.current === deleting) return;
    previousDeleting.current = deleting;
    if (deleting) footer.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else deleteTrigger.current?.focus();
  }, [deleting]);

  useEffect(() => {
    if (editing)
      editForm.current
        ?.querySelector<HTMLInputElement>(`input[name="${editField.current}"]`)
        ?.focus();
  }, [editing]);

  useEffect(() => {
    if (formRevision) bar.current?.querySelector<HTMLButtonElement>('[data-vault-edit]')?.focus();
  }, [formRevision]);

  function discardChanges() {
    hideSecrets();
    setFormRevision((value) => value + 1);
    setDirty(false);
    setEditing(false);
  }

  async function saveChanges(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !details ||
      saving ||
      deleting ||
      !active.current ||
      !event.currentTarget.reportValidity() ||
      !hasChanges(event.currentTarget, details)
    )
      return;
    const data = new FormData(event.currentTarget);
    const expiry = isCard ? parseCardExpiry(data.get('expiry')) : null;
    if (isCard && !expiry) {
      setError('Enter an expiry date as MM / YYYY.');
      editForm.current?.querySelector<HTMLInputElement>('input[name="expiry"]')?.focus();
      return;
    }
    const username = String(data.get('username') ?? '');
    const cardholder = String(data.get('cardholder') ?? '');
    let replacement = String(data.get(isCard ? 'cardNumber' : 'password') ?? '');
    if (isCard && !replacement.trim()) replacement = '';
    const hasPassword =
      details.kind === 'login' && (Boolean(replacement) || details.hasPassword !== false);
    let authenticatorKey = data.get('removeAuthenticator')
      ? ''
      : String(data.get('authenticatorKey') ?? '').trim() || undefined;
    const hasAuthenticator =
      details.kind === 'login' &&
      (authenticatorKey === undefined ? details.hasAuthenticator : Boolean(authenticatorKey));
    let body = JSON.stringify(
      isCard
        ? {
            kind: 'card',
            label: String(data.get('label') ?? ''),
            cardholder,
            ...expiry,
            ...(replacement ? { cardNumber: replacement } : {}),
          }
        : {
            label:
              String(data.get('label') ?? '').trim() ||
              suggestLoginName(entry.kind === 'login' ? entry.origin : ''),
            username,
            ...(replacement ? { password: replacement } : {}),
            ...(authenticatorKey === undefined ? {} : { authenticatorKey }),
          },
    );
    replacement = '';
    authenticatorKey = undefined;
    data.delete('password');
    data.delete('cardNumber');
    data.delete('authenticatorKey');
    hideSecrets();
    const request = new AbortController();
    saveRequest.current = request;
    const current = () =>
      active.current && !request.signal.aborted && saveRequest.current === request;
    setSaving(true);
    try {
      const pending = api<VaultEntry>(`/api/vault/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        body,
        cache: 'no-store',
        signal: request.signal,
      });
      body = '';
      const updated = await pending;
      if (!current()) return;
      if (
        updated.id !== entry.id ||
        updated.kind !== details.kind ||
        (updated.kind === 'login' && details.kind === 'login' && updated.origin !== details.origin)
      )
        throw new Error('Unexpected item');
      setDetails(
        updated.kind === 'card'
          ? { ...updated, cardholder }
          : { ...updated, username, hasPassword, hasAuthenticator },
      );
      setFormRevision((value) => value + 1);
      setDirty(false);
      setEditing(false);
      setNotice(isCard ? 'Card updated.' : 'Login updated.');
      onSaved(updated.kind === 'card' ? updated : { ...updated, username });
    } catch {
      if (current())
        setError(
          isCard
            ? 'This card could not be updated. Try again.'
            : 'This login could not be updated. Check the authenticator key and try again.',
        );
    } finally {
      body = '';
      if (current()) {
        saveRequest.current = null;
        setSaving(false);
      }
    }
  }

  async function remove() {
    if (saving || !active.current || !deleting) return;
    const request = new AbortController();
    saveRequest.current = request;
    const current = () =>
      active.current && !request.signal.aborted && saveRequest.current === request;
    setSaving(true);
    setError('');
    try {
      await api(`/api/vault/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
        cache: 'no-store',
        signal: request.signal,
      });
      if (!current()) return;
      active.current = false;
      detailsRequest.current?.abort();
      hideSecrets();
      setDetails(null);
      onDeleted(entry.id);
    } catch {
      if (current()) setError(`This ${item} could not be deleted. Try again.`);
    } finally {
      if (current()) {
        saveRequest.current = null;
        setSaving(false);
      }
    }
  }

  async function performAction(action: 'identity' | 'show' | 'copy', name?: VaultSecretName) {
    if (!details || busy || saving || deleting || !active.current || document.hidden) return;
    cancelAction();
    const generation = actionGeneration.current;
    const request = new AbortController();
    actionRequest.current = request;
    const current = () =>
      active.current &&
      generation === actionGeneration.current &&
      !request.signal.aborted &&
      !document.hidden;
    const secretLabel = name === 'cardNumber' ? 'card number' : 'password';
    setBusy({ action, name });
    setError('');
    setNotice('');
    let value = '';
    try {
      if (action === 'identity')
        value = details.kind === 'card' ? details.cardholder : details.username;
      else if (name && secrets[name] !== undefined) value = secrets[name]!;
      else if (name) {
        const result = await api<VaultEntryPassword | VaultCardNumber>(
          `/api/vault/${encodeURIComponent(entry.id)}/${name === 'cardNumber' ? 'card-number' : 'password'}`,
          { method: 'POST', body: '{}', cache: 'no-store', signal: request.signal },
        );
        if (!current()) return;
        value = 'password' in result ? result.password : result.cardNumber;
      }
      if (!current()) return;
      if (action === 'show' && name) {
        const revealed = value;
        setSecrets((previous) => ({ ...previous, [name]: revealed }));
      } else {
        const copying = navigator.clipboard.writeText(value);
        value = '';
        await copying;
        if (current())
          setNotice(
            action === 'identity'
              ? `${identityName} copied.`
              : `${secretLabel[0].toUpperCase()}${secretLabel.slice(1)} copied.`,
          );
      }
    } catch {
      if (current()) {
        setSecrets({});
        setError(
          action === 'show'
            ? `The ${secretLabel} could not be shown. Try again.`
            : 'Could not copy to the clipboard. Try again.',
        );
      }
    } finally {
      value = '';
      if (current()) {
        actionRequest.current = null;
        setBusy(null);
      }
    }
  }

  function secretControls(name: VaultSecretName, label: string, mask: string) {
    const value = secrets[name];
    return (
      <>
        {value === undefined ? (
          editableValue(
            name,
            <span className="vault-password-mask" aria-label={`${label} hidden`}>
              {mask}
            </span>,
          )
        ) : (
          <span className="vault-detail-value vault-password-visible">{value}</span>
        )}
        <div className="vault-detail-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${value === undefined ? 'Show' : 'Hide'} ${label.toLowerCase()}`}
            aria-pressed={value !== undefined}
            disabled={saving || (value === undefined && busy !== null)}
            onClick={() =>
              value === undefined ? void performAction('show', name) : hideRevealed()
            }
          >
            {value === undefined ? <Eye size={16} /> : <EyeOff size={16} />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Copy ${label.toLowerCase()}`}
            disabled={saving || busy !== null}
            onClick={() => void performAction('copy', name)}
          >
            <Copy size={16} aria-hidden="true" />
          </Button>
        </div>
      </>
    );
  }

  function close() {
    if (saving) return;
    if (editing) {
      discardChanges();
      return;
    }
    hideSecrets();
    onClose();
  }

  function startEditing(field = 'label') {
    hideRevealed();
    editField.current = field;
    setEditing(true);
  }

  function editableValue(field: string, value: React.ReactNode) {
    const label = `Edit ${field === 'label' ? 'name' : field === 'username' ? identityName.toLowerCase() : field === 'authenticatorKey' ? 'authenticator key' : field}`;
    return (
      <button
        type="button"
        className="vault-detail-value vault-field-edit"
        title={label}
        data-vault-field={field}
        onClick={() => startEditing(field)}
      >
        <span className="sr-only">{label}: </span>
        {value}
      </button>
    );
  }

  const host = entry.kind === 'login' ? originLabel(entry.origin) : '';
  const name = details?.label ?? entry.label;
  const removal = `nod will remove “${name}”${host ? ` for ${host}` : ''} from your vault. You cannot undo this.`;
  const copyButton = (label: string, onClick: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Copy ${label.toLowerCase()}`}
      disabled={saving || busy !== null}
      onClick={onClick}
    >
      <Copy size={16} aria-hidden="true" />
    </Button>
  );
  const field = (label: string, value: React.ReactNode, actions?: React.ReactNode) => (
    <div className="vault-inset-row">
      <span className="vault-inset-label">{label}</span>
      <div className="vault-inset-value">
        {value}
        {actions && <div className="vault-detail-actions">{actions}</div>}
      </div>
    </div>
  );

  return (
    <VaultSurface label={name} autoFocus={autoFocus} onClose={close}>
      <div className="vault-bar" ref={bar}>
        <VaultBackButton label={backLabel} onClick={close} />
        <div className="vault-bar-actions">
          {editing ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={discardChanges}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" form={formId} disabled={saving || !dirty}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-vault-edit
              disabled={!details || saving}
              onClick={() => startEditing()}
            >
              Edit
            </Button>
          )}
        </div>
      </div>
      <div className="vault-hero">
        <span className="vault-hero-icon" aria-hidden="true">
          <VaultEntryIcon entry={entry} size={56} />
        </span>
        <VaultTitle>{name}</VaultTitle>
        <p>
          {entry.kind === 'card' ? (
            `${entry.brand} •••• ${entry.last4}`
          ) : (
            <a href={entry.origin} target="_blank" rel="noopener noreferrer">
              {host}
            </a>
          )}
        </p>
      </div>
      {!details ? (
        detailsError ? (
          <div className="vault-inset-note">
            <Notice>
              {unreadable
                ? 'The current Vault key can’t open this login. Restore the key or delete it.'
                : `This ${item} could not be opened. Try again.`}
            </Notice>
            {!unreadable && (
              <Button variant="outline" onClick={() => void loadDetails()}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <Loading label={`Opening ${item}…`} />
        )
      ) : editing ? (
        <form
          id={formId}
          key={formRevision}
          ref={editForm}
          onSubmit={(event) => void saveChanges(event)}
          onInput={updateDirty}
          className="vault-inset vault-edit-form"
          autoComplete="off"
        >
          <VaultFields kind={entry.kind} details={details} disabled={saving} />
        </form>
      ) : (
        <div className="vault-inset">
          {field(
            identityName,
            editableValue(
              details.kind === 'card' ? 'cardholder' : 'username',
              details.kind === 'card' ? details.cardholder : details.username || '—',
            ),
            copyButton(identityName, () => void performAction('identity')),
          )}
          {details.kind === 'card' ? (
            <>
              {field(
                'Card number',
                secretControls('cardNumber', 'Card number', `•••• ${details.last4}`),
              )}
              {field(
                'Expiry date',
                editableValue('expiry', formatCardExpiry(details.expiryMonth, details.expiryYear)),
              )}
            </>
          ) : (
            <>
              {field(
                'Password',
                details.hasPassword === false
                  ? editableValue('password', <span className="vault-secret-empty">Not saved</span>)
                  : secretControls('password', 'Password', '••••••••'),
              )}
              {field(
                'Authenticator',
                editableValue(
                  'authenticatorKey',
                  details.hasAuthenticator ? (
                    'Saved'
                  ) : (
                    <span className="vault-secret-empty">Not saved</span>
                  ),
                ),
              )}
            </>
          )}
        </div>
      )}
      {error && !deleting && <Notice>{error}</Notice>}
      <p className={notice ? 'vault-detail-status' : 'sr-only'} role="status" aria-live="polite">
        {notice}
      </p>
      {details && !editing && (typeof children === 'function' ? children(details) : children)}
      {(details || detailsError) && (
        <button
          ref={deleteTrigger}
          type="button"
          className="vault-delete"
          disabled={saving}
          onClick={() => {
            hideSecrets();
            setDeleting(true);
          }}
        >
          Delete {item}
        </button>
      )}
      <Dialog
        open={deleting}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setError('');
            setDeleting(false);
          }
        }}
      >
        <DialogContent
          className="vault-confirm"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            footer.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DialogTitle>Delete this {item}?</DialogTitle>
          <DialogDescription>{removal}</DialogDescription>
          {error && <Notice>{error}</Notice>}
          <div ref={footer} className="vault-confirm-actions">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                setError('');
                setDeleting(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={saving} onClick={() => void remove()}>
              {saving ? 'Deleting…' : `Delete ${item}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </VaultSurface>
  );
}
