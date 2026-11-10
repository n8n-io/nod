import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { updatesEmailConsent } from '../../src/shared/onboarding.ts';

const source = ts.createSourceFile(
  'onboarding-updates.workflow.ts',
  await readFile(new URL('./onboarding-updates.workflow.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

let validationCode;
function visit(node) {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText(source) === 'jsCode' &&
    ts.isStringLiteralLike(node.initializer)
  )
    validationCode = node.initializer.text;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(validationCode);

function validate(body) {
  return runInNewContext(`(() => { ${validationCode} })()`, { $json: { body } }, { timeout: 1000 })
    .json;
}

const base = {
  version: 1,
  email: '  PERSON@EXAMPLE.TEST  ',
  consent: true,
  consent_version: updatesEmailConsent.version,
  consent_text: updatesEmailConsent.text,
  consent_privacy_url: updatesEmailConsent.privacyUrl,
};

test('onboarding workflow accepts only consented email and fixed answer choices', () => {
  const accepted = validate(base);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.email, 'person@example.test');
  assert.match(accepted.consent_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(accepted.consent_version, updatesEmailConsent.version);
  assert.equal(accepted.consent_text, updatesEmailConsent.text);
  assert.equal(accepted.consent_privacy_url, updatesEmailConsent.privacyUrl);

  const profile = {
    onboarding_profile_completed: true,
    onboarding_scope: 'work',
    onboarding_roles: ['agency', 'engineering', 'other'],
    onboarding_who_for: 'clients',
    onboarding_company_size: '2_10',
    onboarding_jobs: ['email', 'meetings', 'other'],
  };
  const withProfile = validate({ ...base, profile });
  assert.equal(withProfile.valid, true);
  assert.equal(withProfile.profile.onboarding_roles.join(','), 'agency,engineering,other');

  for (const invalid of [
    { ...base, consent: false },
    { ...base, email: 'not an email' },
    { ...base, consent_at: '2026-11-10T10:00:00.000Z' },
    { ...base, consent_version: 1 },
    { ...base, consent_text: 'Different consent wording' },
    { ...base, consent_privacy_url: 'https://example.test/privacy/' },
    { ...base, extra: 'not allowed' },
    { ...base, profile: { ...profile, roleText: 'private synthetic answer' } },
    { ...base, profile: { ...profile, onboarding_roles: ['agency', 'agency'] } },
    { ...base, profile: { ...profile, onboarding_jobs: ['unsupported'] } },
    { ...base, extra: 'x'.repeat(2048) },
  ])
    assert.equal(validate(invalid).valid, false);
});
