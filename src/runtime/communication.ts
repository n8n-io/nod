import type { CredentialInvitation } from '../ports/agent.ts';

export function vaultInvitation(step: CredentialInvitation, url?: string) {
  const origin = new URL(step.origin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password)
    throw new Error('The sign-in site is unavailable.');
  const site = origin.origin;
  if (step.kind === 'otp')
    return `${site} needs a verification code. Reply here with the code to continue signing in. Otto will send it securely to the website.`;
  if (!url || !/^\/(?:vault|credentials)\/[A-Za-z0-9_-]{1,256}$/.test(url))
    throw new Error('The Vault link is unavailable.');
  if (step.methodSelection)
    return `${site} needs you to sign in. [Choose a sign-in method](${url}) and I will continue the task.`;
  if (!['identifier', 'password'].includes(step.kind))
    throw new Error('The sign-in step is unavailable.');
  if (step.savedLoginAvailable === false)
    return `${site} needs you to sign in. There isn’t a login saved for this website in Vault. [Add login](${url}) and I will continue the task.`;
  if (step.savedLoginAvailable === true)
    return `${site} needs you to sign in. [Continue sign-in](${url}) with your saved login and I will continue the task.`;
  return `${site} needs you to sign in. [Enter login details](${url}) and I will continue the task.`;
}

export function requestsLoginDetails(text: string) {
  const detail =
    '(?:user[ -]?name|password|passcode|passphrase|login identifier|credentials|(?:login|sign[ -]?in) details|recovery code|backup code|authentication code|(?:login|account|X|Twitter) (?:email|e-mail|handle)|one[ -]?time(?: code)?|otp|verification code|security code|nome de utilizador|palavra[ -]passe|código de verificação|codigo de verificacao)';
  return requestsPrivateValue(text, detail);
}

export function requestsApiKey(text: string) {
  return requestsPrivateValue(text, '(?:api[ _-]?key|chave(?: de| da)? api)');
}

function requestsPrivateValue(text: string, detail: string) {
  return (
    new RegExp(
      `(?:what(?:'s|’s| is| are)\\s+your|which\\s+username|(?:send|share|provide|enter|type|tell|give).{0,35}(?:your|me)|i\\s+(?:need|require)|(?:qual|envia|partilha|fornece|introduz|escreve|preciso|diz).{0,35}(?:teu|tua|seu|sua|me|de)).{0,100}\\b${detail}\\b`,
      'i',
    ).test(text) ||
    new RegExp(`\\b${detail}\\b.{0,40}\\b(?:please|to continue|por favor)\\b`, 'i').test(text)
  );
}

export function requestsManualSignIn(text: string) {
  const signIn = '(?:sign(?:ing)?|log(?:ging)?)[ -]?(?:in|into)';
  return (
    /\bsign[ -]?in in (?:the )?browser\b|\bcontinue in otto\b/i.test(text) ||
    new RegExp(
      `\\b${signIn}\\b.{0,120}\\b(?:manually|yourself|separate (?:browser )?window|browser controls?|take control)\\b`,
      'i',
    ).test(text) ||
    new RegExp(
      `\\b(?:take control|(?:open|use|choose|switch to).{0,40}(?:browser|window))\\b.{0,100}\\b${signIn}\\b`,
      'i',
    ).test(text)
  );
}

export function userRequestsManualSignIn(text: string) {
  if (
    /\b(?:instead of|rather than)\b.{0,100}\b(?:sign[ -]?in|manual|browser)\b/i.test(text) ||
    /\b(?:do not|don't|don’t|never|stop|avoid)\b[^.;\n]{0,100}\b(?:sign[ -]?in|log[ -]?in|manual|browser)\b/i.test(
      text,
    )
  )
    return false;
  return (
    requestsManualSignIn(text) &&
    /\b(?:how (?:can|do|should) i|where (?:is|do i)|show me|help me|let me|i (?:want|need|prefer|would like)|can i|open|explain)\b[^.;\n]{0,160}\b(?:sign[ -]?in|log[ -]?in|manual|browser)\b/i.test(
      text,
    )
  );
}
