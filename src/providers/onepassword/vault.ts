import {
  createClient,
  DesktopAuth,
  DesktopSessionExpiredError,
  ItemCategory,
  ItemFieldType,
  type Client,
  type Item,
} from '@1password/sdk';
import {
  PasswordManagerError,
  type PasswordManagerLogin,
  type PasswordManagerSecret,
} from '../../ports/password-manager.ts';
import { matchingWebsite } from './websites.ts';

function failure(reason: 'unavailable' | 'failed', error: unknown) {
  if (error instanceof PasswordManagerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PasswordManagerError(reason, `1Password: ${message.slice(0, 300)}`);
}

function field(item: Item, id: string) {
  return item.fields.find((value) => value.id === id)?.value ?? '';
}

const active = { type: 'ByState', content: { active: true, archived: false } } as const;

function reference(id: string) {
  const [vaultId, itemId, ...rest] = id.split('/');
  if (!vaultId || !itemId || rest.length)
    throw new PasswordManagerError('missing', 'This 1Password login is no longer available.');
  return { vaultId, itemId };
}

export function onePasswordVault(version: string) {
  const clients = new Map<string, Promise<Client>>();

  function client(account: string) {
    let opened = clients.get(account);
    if (!opened) {
      opened = createClient({
        auth: new DesktopAuth(account),
        integrationName: 'nod',
        integrationVersion: version,
      });
      opened.catch(() => clients.delete(account));
      clients.set(account, opened);
    }
    return opened;
  }

  async function use<T>(account: string, run: (op: Client) => Promise<T>) {
    const open = () =>
      client(account).catch((error: unknown) => {
        throw failure('unavailable', error);
      });
    try {
      return await run(await open());
    } catch (error) {
      if (!(error instanceof DesktopSessionExpiredError)) throw failure('failed', error);
      clients.delete(account);
      try {
        return await run(await open());
      } catch (retry) {
        throw failure('failed', retry);
      }
    }
  }

  async function logins(account: string, origin: string): Promise<PasswordManagerLogin[]> {
    return use(account, async (op) => {
      const found: PasswordManagerLogin[] = [];
      for (const vault of await op.vaults.list()) {
        const websites = new Map(
          (await op.items.list(vault.id, active)).flatMap((item) => {
            const website =
              item.category === ItemCategory.Login && matchingWebsite(item.websites, origin);
            return website ? [[item.id, website] as const] : [];
          }),
        );
        if (!websites.size) continue;
        const { individualResponses } = await op.items.getAll(vault.id, [...websites.keys()]);
        for (const { content: item } of individualResponses)
          if (item && websites.has(item.id) && field(item, 'password'))
            found.push({
              id: `${vault.id}/${item.id}`,
              title: item.title,
              username: field(item, 'username'),
              website: websites.get(item.id)!,
            });
      }
      return found;
    });
  }

  async function login(
    account: string,
    origin: string,
    id: string,
  ): Promise<PasswordManagerSecret> {
    const { vaultId, itemId } = reference(id);
    return use(account, async (op) => {
      if (!(await op.items.list(vaultId, active)).some((overview) => overview.id === itemId))
        throw new PasswordManagerError('missing', 'This 1Password login is no longer available.');
      const item = await op.items.get(vaultId, itemId);
      if (item.category !== ItemCategory.Login || !matchingWebsite(item.websites, origin))
        throw new PasswordManagerError('missing', 'This 1Password login is not for this website.');
      const password = field(item, 'password');
      if (!password)
        throw new PasswordManagerError('missing', 'This 1Password login has no password.');
      const authenticatorKey = item.fields.find(
        (value) => value.fieldType === ItemFieldType.Totp,
      )?.value;
      return {
        title: item.title,
        username: field(item, 'username'),
        password,
        ...(authenticatorKey ? { authenticatorKey } : {}),
      };
    });
  }

  return { logins, login };
}
