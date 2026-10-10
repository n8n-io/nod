import { useState } from 'react';
import type { VaultImportResult } from '../../shared/contracts';
import { parsePasswordCsv, type ImportedLogin } from '../../shared/password-import';
import { api, errorMessage } from '../lib/api';
import { formatNumber } from '../lib/date-format';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Notice } from './ui';

function logins(count: number) {
  return count === 1 ? '1 login' : `${formatNumber(count)} logins`;
}

export function VaultImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onImported(): void;
}) {
  const [file, setFile] = useState<{ name: string; logins: ImportedLogin[] } | null>(null);
  const [result, setResult] = useState<VaultImportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function close(next: boolean) {
    if (busy) return;
    if (!next) {
      setFile(null);
      setResult(null);
      setError('');
    }
    onOpenChange(next);
  }

  async function choose(chosen: File | undefined) {
    setFile(null);
    setError('');
    if (!chosen) return;
    try {
      setFile({ name: chosen.name, logins: parsePasswordCsv(await chosen.text()) });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setResult(
        await api<VaultImportResult>('/api/vault/import', {
          method: 'POST',
          body: JSON.stringify({ logins: file.logins }),
        }),
      );
      setFile(null);
      onImported();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="vault-dialog">
        <DialogTitle>Import passwords</DialogTitle>
        {result ? (
          <>
            <DialogDescription>
              {[
                `Imported ${logins(result.imported)}`,
                result.existing ? `${formatNumber(result.existing)} already saved` : '',
                result.skipped ? `${formatNumber(result.skipped)} skipped` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              . Now delete the exported file. It isn’t encrypted.
            </DialogDescription>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                close(false);
              }}
            >
              <Button type="submit" autoFocus>
                Done
              </Button>
            </form>
          </>
        ) : (
          <>
            <DialogDescription>
              Export a CSV from Chrome, 1Password or another password manager and choose it here.
            </DialogDescription>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Button asChild variant="outline">
                <label className="vault-import-file">
                  {file ? file.name : 'Choose file'}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => void choose(event.target.files?.[0])}
                  />
                </label>
              </Button>
              {file && (
                <p>{file.logins.length ? logins(file.logins.length) : 'No logins in this file.'}</p>
              )}
              {error && <Notice>{error}</Notice>}
              <Button type="submit" disabled={!file?.logins.length || busy}>
                Import
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
