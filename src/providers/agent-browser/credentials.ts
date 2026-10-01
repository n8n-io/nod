import type { CredentialInput } from '../../ports/computer.ts';

export interface CredentialField {
  selector: string;
  value: string;
  code: boolean;
}

export function credentialFields(input: CredentialInput): CredentialField[] {
  const kind = input.kind ?? 'password';
  const value =
    kind === 'identifier' ? input.username : kind === 'otp' ? input.code : input.password;
  if (!value || value.length > (kind === 'otp' ? 100 : 8192) || (input.username?.length ?? 0) > 320)
    throw new Error('A valid credential value is required.');
  const fields = [
    ...(kind === 'password' && input.username && input.usernameSelector
      ? [{ selector: input.usernameSelector, value: input.username, code: false }]
      : []),
    {
      selector: (kind === 'identifier' ? input.usernameSelector : input.passwordSelector) ?? '',
      value,
      code: kind === 'otp',
    },
  ];
  for (const { selector } of fields)
    if (
      !selector ||
      selector.length > 500 ||
      (/^[\s@-]/.test(selector) && !/^@e\d+$/.test(selector)) ||
      selector.includes('\0')
    )
      throw new Error('Secure entry requires a page field selector or browser reference.');
  return fields;
}
