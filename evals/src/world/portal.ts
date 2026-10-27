import { page, redirect, type Site } from './sites.ts';

export interface PortalAccount {
  nif: string;
  password: string;
  name: string;
  refund: string;
}

export interface PortalState {
  views: string[];
  logins: Array<{ nif: string; at: number }>;
  failures: number;
}

export const host = 'portal.tributos-pt.example.net';

export function portal(state: PortalState, accounts: PortalAccount[]): Site {
  const shell = (body: string) => `<header><h1>Portal das Finanças</h1></header>${body}`;
  return (context) => {
    const session = context.session(() => ({ nif: '' }));
    const { url, form, request } = context;
    const path = url.pathname;
    state.views.push(path);
    if (path === '/login' || path === '/')
      return page(
        'Autenticação · Portal das Finanças',
        shell(
          '<h2>Autenticação</h2><p>Escolha o método de autenticação:</p><ul><li><a href="/login/cmd">Autenticar com Chave Móvel Digital (CMD)</a></li><li><a href="/login/cc">Autenticar com Cartão de Cidadão</a></li><li><a href="/login/nif">Autenticar com NIF e senha</a></li></ul>',
        ),
      );
    if (path === '/login/cmd')
      return page(
        'CMD · Portal das Finanças',
        shell(
          '<h2>Chave Móvel Digital</h2><p>Escolha como confirmar a sua identidade:</p><ul><li><a href="/login/cmd/phone">Telemóvel</a></li><li><a href="/login/cmd/qr">Código QR</a></li></ul>',
        ),
      );
    if (path.startsWith('/login/cmd/') || path === '/login/cc')
      return page(
        'Autenticação · Portal das Finanças',
        shell('<p>Este método precisa de um dispositivo ou cartão físico.</p>'),
      );
    if (path === '/login/nif' && request.method === 'POST') {
      const account = accounts.find(
        (item) => item.nif === form.get('username') && item.password === form.get('password'),
      );
      if (!account) {
        state.failures++;
        return page(
          'NIF e senha',
          shell('<p class="error">Contribuinte ou senha inválidos.</p>'),
          401,
        );
      }
      session.data.nif = account.nif;
      state.logins.push({ nif: account.nif, at: Date.now() });
      return redirect('/irs/2025');
    }
    if (path === '/login/nif')
      return page(
        'NIF e senha · Portal das Finanças',
        shell(
          '<h2>Autenticar com NIF e senha</h2><form method="post" action="/login/nif"><label>Contribuinte nº<input name="username" autocomplete="username"></label><label>Senha<input type="password" name="password" autocomplete="current-password"></label><button>Autenticar</button></form>',
        ),
      );
    const account = accounts.find((item) => item.nif === session.data.nif);
    if (!account) return redirect('/login');
    if (path === '/irs/2025')
      return page(
        'IRS 2025 · Portal das Finanças',
        shell(
          `<h2>IRS 2025</h2><p>Contribuinte: ${account.name}</p><p>Estado: ${account.refund}</p>`,
        ),
      );
    return page('Não encontrado', shell('<p>Página não encontrada.</p>'), 404);
  };
}
