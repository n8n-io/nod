function plain(value: string) {
  return value
    .replace(/[[\]()<>`*_~#|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function vaultInvitation(
  origin: string,
  url: string | undefined,
  message: string,
  action: string,
) {
  const site = new URL(origin);
  if (!['https:', 'http:'].includes(site.protocol) || site.username || site.password)
    throw new Error('The sign-in site is unavailable.');
  if (!url || !/^\/(?:vault|credentials)\/[A-Za-z0-9_-]{1,256}$/.test(url))
    throw new Error('The Vault link is unavailable.');
  const text = plain(message);
  const label = plain(action);
  if (!text || !label) throw new Error('Describe the secure step and its button.');
  return `${text} [${label}](${url})`;
}

export function requestsPrivateInput(text: string) {
  const detail =
    '(?:user[ -]?name|password|passcode|passphrase|pin(?: code)?|login identifier|credentials|(?:login|sign[ -]?in) details|recovery code|backup code|authentication code|(?:login|account|X|Twitter) (?:email|e-mail|handle)|one[ -]?time(?: code)?|otp|verification code|security code|sms code|api[ _-]?key|nome de utilizador|palavra[ -]passe|codigo (?:de (?:verificacao|seguranca|confirmacao|autenticacao|verificacion|seguridad|confirmacion|autenticacion)|pin)|code de (?:verification|securite|confirmation|authentification)|chave(?: de| da)? api|nif|eori|numero (?:de )?(?:contribuinte|identificacao fiscal)|tax (?:identification )?(?:number|id)|contrasena|mot de passe)';
  const normalized = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return (
    requestsPrivateValue(normalized, detail) ||
    requestsPrivateValue(
      normalized,
      '(?:code|codigo)(?=\\s*(?:[?.!:]|$)|\\s+(?:to continue|para continuar|pour continuer|please|por favor|you received|que recebeste|que recebeu|recebido|(?:por|via) (?:sms|email)|sent (?:by|via) (?:sms|email)))',
    ) ||
    (/sign(?:ing)?[ -]?in|log(?:ging)?[ -]?in|iniciar sessao|autentic|chave movel|\bcmd\b/i.test(
      normalized,
    ) &&
      requestsPrivateValue(
        normalized,
        '(?:(?:phone|mobile|telephone) number|(?:numero de )?(?:telemovel|telefone)|email|e-mail)',
        false,
      ))
  );
}

function requestsPrivateValue(text: string, detail: string, shorthand = true) {
  return (
    new RegExp(
      `(?:what(?:'s|’s| is| are)\\s+your|which\\s+username|(?:send|share|provide|enter|type|tell|give)\\b.{0,35}\\b(?:your|me)\\b|i\\s+(?:need|require)|qual\\b.{0,20}\\b(?:teu|tua|seu|sua)\\b|(?:envia|partilha|fornece|introduz|escreve|preciso|diz|indica|indique)\\b.{0,35}\\b(?:teu|tua|seu|sua|me|de|do|da|tu)\\b|(?:envoyez|partagez|fournissez|saisissez|indiquez|donnez)\\b.{0,35}\\b(?:votre|vos|moi)\\b).{0,100}\\b${detail}\\b`,
      'i',
    ).test(text) ||
    new RegExp(`(?:what(?:'s|’s| is)|qual e)\\s+(?:the|o|a)\\s+${detail}\\b`, 'i').test(text) ||
    new RegExp(
      `(?:quel(?:le)? est|cual es)\\s+(?:votre|vos|le|la|tu|su|el)\\s+${detail}\\b`,
      'i',
    ).test(text) ||
    new RegExp(
      `\\b(?:enter|provide|send|share|type|envia(?:r)?|fornece(?:r)?|escreve(?:r)?|introduz(?:ir)?|indica(?:r)?|indique)\\s+(?:(?:me|your|the|o|a|teu|tua|seu|sua)\\s+){0,2}${detail}\\b`,
      'i',
    ).test(text) ||
    new RegExp(
      shorthand
        ? `\\b${detail}\\b.{0,40}\\b(?:please|to continue|por favor)\\b`
        : `(?:^|[.!?:]\\s+)\\s*(?:(?:your|o teu|o seu|a tua|a sua|teu|seu|tua|sua)\\s+)?${detail}\\b\\s*,?\\s*(?:please|por favor)\\b`,
      'i',
    ).test(text)
  );
}
