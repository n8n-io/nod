import { useEffect, useId, useRef, useState } from 'react';
import { CreditCard, Globe } from './icons';
import type { VaultEntry, VaultEntryDetails, VaultListEntry } from '../../shared/contracts';
import { api } from '../lib/api';
import { Button, Checkbox, Field, Input, Notice } from './ui';
import { suggestLoginName } from '../lib/vault-name';
import { VaultTitle } from './vault-surface';

export function formatCardExpiry(month: number, year: number) {
  return `${String(month).padStart(2, '0')} / ${year}`;
}

export function parseCardExpiry(value: FormDataEntryValue | null) {
  const match = String(value ?? '').match(/^\s*(0?[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})\s*$/);
  if (!match) return null;
  return {
    expiryMonth: Number(match[1]),
    expiryYear: match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]),
  };
}

export function clearVaultSecret(form: HTMLFormElement | null) {
  form
    ?.querySelectorAll<HTMLInputElement>(
      'input[name="password"], input[name="cardNumber"], input[name="authenticatorKey"]',
    )
    .forEach((input) => (input.value = ''));
}

export type VaultSecretName = 'password' | 'cardNumber';

function VaultSecretField({
  name,
  label,
  editing,
  saved = true,
  disabled,
}: {
  name: VaultSecretName;
  label: string;
  editing: boolean;
  saved?: boolean;
  disabled: boolean;
}) {
  return (
    <Field label={name === 'password' ? `${label} (optional)` : label}>
      <Input
        name={name}
        type="password"
        placeholder={editing ? (saved ? 'Leave blank to keep current' : 'Not saved') : undefined}
        inputMode={name === 'password' ? undefined : 'numeric'}
        autoComplete={name === 'cardNumber' ? 'cc-number' : 'new-password'}
        maxLength={name === 'cardNumber' ? 32 : 8192}
        required={!editing && name === 'cardNumber'}
        disabled={disabled}
      />
    </Field>
  );
}

function AuthenticatorKeyField({ saved, disabled }: { saved: boolean; disabled: boolean }) {
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Field label="Authenticator key (optional)">
        <Input
          name="authenticatorKey"
          type="password"
          placeholder={
            removing
              ? 'Will be removed'
              : saved
                ? 'Leave blank to keep current'
                : 'Setup key or otpauth:// link'
          }
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={2048}
          disabled={disabled || removing}
        />
      </Field>
      {saved && (
        <label className="vault-check">
          <Checkbox
            name="removeAuthenticator"
            checked={removing}
            disabled={disabled}
            onChange={(event) => setRemoving(event.target.checked)}
          />
          <span>Remove saved key</span>
        </label>
      )}
    </>
  );
}

export function VaultFields({
  kind,
  details,
  disabled,
}: {
  kind: 'login' | 'card';
  details?: VaultEntryDetails;
  disabled: boolean;
}) {
  const identityLabel =
    details?.kind === 'login'
      ? (details.identifierLabel ?? 'Username or email')
      : kind === 'card'
        ? 'Cardholder name'
        : 'Username or email';
  return (
    <>
      <Field label="Name">
        <Input
          name="label"
          defaultValue={details?.label}
          placeholder={kind === 'card' ? 'For example, everyday card' : 'For example, work account'}
          required={kind === 'card'}
          maxLength={100}
          disabled={disabled}
        />
      </Field>
      {kind === 'login' && (
        <Field label="Website domain">
          <Input
            name="origin"
            defaultValue={details?.kind === 'login' ? details.origin : undefined}
            readOnly={Boolean(details)}
            placeholder="example.com"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={2048}
            disabled={disabled}
          />
        </Field>
      )}
      <Field label={identityLabel}>
        <Input
          name={kind === 'card' ? 'cardholder' : 'username'}
          defaultValue={details?.kind === 'card' ? details.cardholder : (details?.username ?? '')}
          autoComplete={kind === 'card' ? 'cc-name' : 'username'}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={kind === 'card' ? 200 : 320}
          required={kind === 'card'}
          disabled={disabled}
        />
      </Field>
      <VaultSecretField
        name={kind === 'card' ? 'cardNumber' : 'password'}
        label={kind === 'card' ? 'Card number' : 'Password'}
        editing={Boolean(details)}
        saved={details?.kind !== 'login' || details.hasPassword !== false}
        disabled={disabled}
      />
      {kind === 'login' && (
        <AuthenticatorKeyField
          saved={details?.kind === 'login' && details.hasAuthenticator}
          disabled={disabled}
        />
      )}
      {kind === 'card' && (
        <Field label="Expiry date">
          <Input
            name="expiry"
            defaultValue={
              details?.kind === 'card'
                ? formatCardExpiry(details.expiryMonth, details.expiryYear)
                : ''
            }
            placeholder="MM / YYYY"
            inputMode="numeric"
            autoComplete="cc-exp"
            maxLength={9}
            required
            disabled={disabled}
          />
        </Field>
      )}
    </>
  );
}

export function VaultItemForm({
  kind,
  onSaved,
  onCancel,
  onSavingChange,
}: {
  kind: 'login' | 'card';
  onSaved(entry: VaultListEntry): void;
  onCancel(): void;
  onSavingChange?(saving: boolean): void;
}) {
  const formId = useId();
  const [saving, setSaving] = useState(false);
  useEffect(() => onSavingChange?.(saving), [saving, onSavingChange]);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    form.current?.querySelector<HTMLInputElement>('input[name="label"]')?.focus();
    const clear = () => clearVaultSecret(form.current);
    const hidden = () => document.hidden && clear();
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      active.current = false;
      request.current?.abort();
      clear();
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !active.current) return;
    const values = new FormData(event.currentTarget);
    const expiry = kind === 'card' ? parseCardExpiry(values.get('expiry')) : null;
    if (kind === 'card' && !expiry) {
      setError('Enter an expiry date as MM / YYYY.');
      form.current?.querySelector<HTMLInputElement>('input[name="expiry"]')?.focus();
      return;
    }
    const origin = String(values.get('origin') ?? '').trim();
    const label =
      String(values.get('label') ?? '').trim() ||
      (kind === 'login'
        ? suggestLoginName(origin.includes('://') ? origin : `https://${origin}`)
        : '');
    const username = String(values.get('username') ?? '').trim();
    if (kind === 'login' && !username && !values.get('password')) {
      setError('Add a username, email or password for this login.');
      form.current?.querySelector<HTMLInputElement>('input[name="username"]')?.focus();
      return;
    }
    let body = JSON.stringify(
      kind === 'card'
        ? {
            kind,
            label,
            cardholder: String(values.get('cardholder') ?? ''),
            cardNumber: String(values.get('cardNumber') ?? ''),
            ...expiry,
          }
        : {
            label,
            origin,
            username,
            password: String(values.get('password') ?? ''),
            ...(String(values.get('authenticatorKey') ?? '').trim()
              ? { authenticatorKey: String(values.get('authenticatorKey')) }
              : {}),
          },
    );
    values.delete('password');
    values.delete('cardNumber');
    values.delete('authenticatorKey');
    clearVaultSecret(form.current);
    const controller = new AbortController();
    request.current = controller;
    const current = () =>
      active.current && !controller.signal.aborted && request.current === controller;
    setSaving(true);
    setError('');
    try {
      const pending = api<VaultEntry>('/api/vault', {
        method: 'POST',
        body,
        cache: 'no-store',
        signal: controller.signal,
      });
      body = '';
      const entry = await pending;
      if (!current()) return;
      if (entry.kind !== kind) throw new Error('Unexpected item');
      form.current?.reset();
      onSaved(entry.kind === 'login' ? { ...entry, username } : entry);
    } catch {
      if (current())
        setError(
          kind === 'card'
            ? 'This card could not be saved. Check the details and try again.'
            : 'This login could not be saved. Check the website and authenticator key, then try again.',
        );
    } finally {
      body = '';
      if (current()) {
        request.current = null;
        setSaving(false);
      }
    }
  }

  return (
    <>
      <div className="vault-bar">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <div className="vault-bar-actions">
          <Button type="submit" size="sm" form={formId} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <div className="vault-hero">
        <span className="vault-hero-icon" aria-hidden="true">
          {kind === 'card' ? <CreditCard size={48} /> : <Globe size={48} />}
        </span>
        <VaultTitle>{kind === 'card' ? 'New payment card' : 'New login'}</VaultTitle>
      </div>
      <form
        id={formId}
        ref={form}
        onSubmit={(event) => void submit(event)}
        className="vault-inset vault-add-form"
        autoComplete="off"
      >
        <VaultFields kind={kind} disabled={saving} />
      </form>
      {error && <Notice>{error}</Notice>}
    </>
  );
}
