import type { CredentialInput } from '../../ports/computer.ts';

interface CredentialField {
  selector: string;
  value: string;
  code: boolean;
}

export function credentialFields(input: CredentialInput): CredentialField[] {
  const kind = input.kind ?? 'password';
  const value =
    kind === 'identifier' ? input.username : kind === 'otp' ? input.code : input.password;
  if (!value) throw new Error('A valid credential value is required.');
  const target = (kind === 'identifier' ? input.usernameSelector : input.passwordSelector) ?? '';
  const characters = Array.from(value);
  if (
    Array.isArray(target) &&
    (kind !== 'otp' ||
      target.length !== characters.length ||
      target.some((selector) => !/^@e\d+$/.test(selector)) ||
      new Set(target).size !== target.length)
  )
    throw new Error('Choose one distinct field for each code character, in code order.');
  const fields = [
    ...(kind === 'password' && input.username && input.usernameSelector
      ? [{ selector: input.usernameSelector, value: input.username, code: false }]
      : []),
    ...(Array.isArray(target)
      ? target.map((selector, index) => ({
          selector,
          value: characters[index]!,
          code: false,
        }))
      : [{ selector: target, value, code: kind === 'otp' }]),
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
