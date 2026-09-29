import { useEffect, useId, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, ExternalLink, Trash2 } from 'lucide-react';
import type {
  VaultEntry,
  VaultEntryDetails,
  VaultEntryPassword,
  VaultCardNumber,
  VaultCardSecurityCode,
  VaultListEntry,
} from '../../shared/contracts';
import { api } from '../lib/api';
import { originLabel } from '../lib/vault-name';
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
    ['password', 'cardNumber', 'securityCode', 'removeSecurityCode'].some((name) => data.has(name))
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
  onClose,
  onSaved,
  onDeleted,
}: {
  entry: VaultEntry;
  autoFocus?: boolean;
  onClose(): void;
  onSaved(entry: VaultListEntry): void;
  onDeleted(id: string): void;
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
  const footer = useRef<HTMLDivElement>(null);
  const previousDeleting = useRef(deleting);
  const active = useRef(false);
  const detailsRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const actionGeneration = useRef(0);
  const isCard = entry.kind === 'card';
  const item = isCard ? 'card' : 'login';
  const identityName =
    details?.kind === 'login'
      ? (details.identifierLabel ?? 'Username')
      : isCard
        ? 'Cardholder name'
        : 'Username';

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
  }

  function updateDirty() {
    if (details && editForm.current && !saving) setDirty(hasChanges(editForm.current, details));
  }

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
    void loadDetails();
    const hidden = () => {
      if (document.hidden) hideSecrets();
    };
    window.addEventListener('blur', hideSecrets);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      active.current = false;
      detailsRequest.current?.abort();
      saveRequest.current?.abort();
      cancelAction();
      clearVaultSecret(editForm.current);
      window.removeEventListener('blur', hideSecrets);
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
    if (editing) editForm.current?.querySelector<HTMLInputElement>('input[name="label"]')?.focus();
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
    if (isCard && data.has('cardNumber') && !replacement.trim()) {
      setError('Enter the new card number or cancel this change.');
      event.currentTarget.querySelector<HTMLInputElement>('[name="cardNumber"]')?.focus();
      return;
    }
    let securityCode = data.has('removeSecurityCode')
      ? null
      : String(data.get('securityCode') ?? '');
    const hasSecurityCode =
      details.kind === 'card' &&
      (securityCode === null ? false : Boolean(securityCode) || details.hasSecurityCode);
    let body = JSON.stringify(
      isCard
        ? {
            kind: 'card',
            label: String(data.get('label') ?? ''),
            cardholder,
            ...expiry,
            ...(replacement ? { cardNumber: replacement } : {}),
            ...(securityCode === null || securityCode ? { securityCode } : {}),
          }
        : {
            label: String(data.get('label') ?? ''),
            username,
            ...(replacement ? { password: replacement } : {}),
          },
    );
    replacement = '';
    securityCode = '';
    data.delete('password');
    data.delete('cardNumber');
    data.delete('securityCode');
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
          ? { ...updated, cardholder, hasSecurityCode }
          : { ...updated, username },
      );
      setFormRevision((value) => value + 1);
      setDirty(false);
      setEditing(false);
      setNotice(isCard ? 'Card updated.' : 'Login updated.');
      onSaved(updated.kind === 'card' ? updated : { ...updated, username });
    } catch {
      if (current()) setError(`This ${item} could not be updated. Try again.`);
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
    const secretLabel =
      name === 'securityCode'
        ? 'security code'
        : name === 'cardNumber'
          ? 'card number'
          : 'password';
    setBusy({ action, name });
    setError('');
    setNotice('');
    let value = '';
    try {
      if (action === 'identity')
        value = details.kind === 'card' ? details.cardholder : details.username;
      else if (name && secrets[name] !== undefined) value = secrets[name]!;
      else if (name) {
        const endpoint =
          name === 'cardNumber'
            ? 'card-number'
            : name === 'securityCode'
              ? 'security-code'
              : 'password';
        const result = await api<VaultEntryPassword | VaultCardNumber | VaultCardSecurityCode>(
          `/api/vault/${encodeURIComponent(entry.id)}/${endpoint}`,
          { method: 'POST', body: '{}', cache: 'no-store', signal: request.signal },
        );
        if (!current()) return;
        value =
          'password' in result
            ? result.password
            : 'cardNumber' in result
              ? result.cardNumber
              : result.securityCode;
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
          <span className="vault-password-mask" aria-label={`${label} hidden`}>
            {mask}
          </span>
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
    active.current = false;
    detailsRequest.current?.abort();
    saveRequest.current?.abort();
    hideSecrets();
    setDetails(null);
    onClose();
  }

  const host = entry.kind === 'login' ? originLabel(entry.origin) : '';
  const name = details?.label ?? entry.label;
  const removal = `Otto will remove “${name}”${host ? ` for ${host}` : ''} from your vault. You cannot undo this.`;
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
        <VaultBackButton onClick={close} />
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
              onClick={() => {
                hideRevealed();
                setEditing(true);
              }}
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
        <p>{entry.kind === 'card' ? `${entry.brand} •••• ${entry.last4}` : host}</p>
      </div>
      {!details ? (
        detailsError ? (
          <div className="vault-inset-note">
            <Notice>This {item} could not be opened. Try again.</Notice>
            <Button variant="outline" onClick={() => void loadDetails()}>
              Try again
            </Button>
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
          <VaultFields
            kind={entry.kind}
            details={details}
            disabled={saving}
            onSecretChange={() => {
              hideRevealed();
              updateDirty();
            }}
          />
          {entry.kind === 'login' &&
            field('Website', <span className="vault-detail-value">{host}</span>)}
        </form>
      ) : (
        <div className="vault-inset">
          {field(
            identityName,
            <span className="vault-detail-value">
              {details.kind === 'card' ? details.cardholder : details.username || '—'}
            </span>,
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
                <span className="vault-detail-value">
                  {formatCardExpiry(details.expiryMonth, details.expiryYear)}
                </span>,
              )}
              {details.hasSecurityCode &&
                field('Security code', secretControls('securityCode', 'Security code', '••••'))}
            </>
          ) : (
            <>
              {field('Password', secretControls('password', 'Password', '••••••••'))}
              {field(
                'Website',
                <span className="vault-detail-value">{host}</span>,
                <Button asChild variant="ghost" size="icon">
                  <a
                    href={entry.kind === 'login' ? entry.origin : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${host}`}
                  >
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                </Button>,
              )}
            </>
          )}
        </div>
      )}
      {error && !deleting && <Notice>{error}</Notice>}
      <p className={notice ? 'vault-detail-status' : 'sr-only'} role="status" aria-live="polite">
        {notice}
      </p>
      {details && !editing && (
        <div className="vault-inset">
          <button
            ref={deleteTrigger}
            type="button"
            className="button button-ghost button-default vault-delete-row"
            disabled={saving}
            onClick={() => {
              hideSecrets();
              setDeleting(true);
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
            Delete {item}
          </button>
        </div>
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
