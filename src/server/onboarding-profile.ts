import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  profileBusinessRoles,
  profileCompanySizes,
  profileJobs,
  profileRoles,
  profileScopes,
  profileTextChars,
  profileWhoFor,
  type OnboardingProfile,
} from '../shared/onboarding.ts';
import type { MemoryService } from './memory.ts';
import { archive, locate, unsafe } from './memory-tree.ts';

function choice<T extends string>(list: readonly { id: T }[]) {
  return z.enum(list.map((option) => option.id) as [T, ...T[]]);
}

const text = z.string().trim().min(1).max(profileTextChars);
const profileInput = z
  .object({
    scope: choice(profileScopes).optional(),
    roles: z.array(choice(profileRoles)).max(profileRoles.length),
    roleText: text.optional(),
    whoFor: choice(profileWhoFor).optional(),
    companySize: choice(profileCompanySizes).optional(),
    jobs: z.array(choice(profileJobs)).max(profileJobs.length),
    jobsText: text.optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (new Set(profile.roles).size !== profile.roles.length)
      context.addIssue({ code: 'custom', path: ['roles'], message: 'Choose each role once.' });
    if (new Set(profile.jobs).size !== profile.jobs.length)
      context.addIssue({ code: 'custom', path: ['jobs'], message: 'Choose each task once.' });
    if (
      profile.scope !== 'personal' &&
      profile.roles.some((role) => role === 'student' || role === 'not_working')
    )
      context.addIssue({ code: 'custom', path: ['roles'], message: 'Role is not available.' });
    if (profile.whoFor && !profile.roles.some((role) => profileBusinessRoles.includes(role)))
      context.addIssue({ code: 'custom', path: ['whoFor'], message: 'Answer is not applicable.' });
    if (profile.scope === 'personal' && profile.companySize)
      context.addIssue({
        code: 'custom',
        path: ['companySize'],
        message: 'Answer is not applicable.',
      });
  });
const updatesEmailInput = z
  .object({ email: z.email().trim().max(254), consent: z.literal(true) })
  .strict();

function label(list: readonly { id: string; label: string }[], id?: string) {
  return list.find((option) => option.id === id)?.label;
}

export function profileNote(profile: OnboardingProfile) {
  const split =
    unsafe(`${profile.roleText ?? ''}${profile.jobsText ?? ''}`) &&
    !unsafe(profile.roleText, profile.jobsText);
  const own = (value?: string) => (value && !split && !unsafe(value) ? value : undefined);
  const roles = [
    ...new Set(profile.roles.map((role) => label(profileRoles, role))),
    own(profile.roleText),
  ].filter(Boolean);
  const jobs = [
    ...new Set(profile.jobs.map((job) => label(profileJobs, job))),
    own(profile.jobsText),
  ].filter(Boolean);
  return [
    profile.scope && `Where they want Nod’s help: ${label(profileScopes, profile.scope)}.`,
    roles.length && `What they do: ${roles.join('; ')}.`,
    profile.whoFor && `Who it’s for: ${label(profileWhoFor, profile.whoFor)}.`,
    profile.companySize && `Company size: ${label(profileCompanySizes, profile.companySize)}.`,
    jobs.length && `What they want off their plate first: ${jobs.join('; ')}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function createOnboardingProfile(options: {
  memory: Pick<MemoryService, 'edit' | 'enabled' | 'restate'>;
  profileAnalytics?: { enabled(): boolean; submit(profile: OnboardingProfile): Promise<boolean> };
  updatesEmail?: { enabled(): boolean; submit(email: string): Promise<boolean> };
}) {
  function registerRoutes(app: FastifyInstance) {
    app.post('/api/onboarding/profile', async (request, response) => {
      const profile = profileInput.parse(request.body);
      const note = profileNote(profile);
      response.header('cache-control', 'no-store');
      if (await options.memory.enabled()) {
        if (note) await options.memory.restate([{ area: 'about', slug: 'onboarding', text: note }]);
        else
          await options.memory.edit((tree) => {
            const previous = locate(tree, 'about/onboarding');
            if (previous) archive(tree, previous, 'superseded', new Date().toISOString());
          });
      }
      if (options.profileAnalytics?.enabled()) {
        const saved = await options.profileAnalytics.submit(profile).catch(() => false);
        if (!saved && options.profileAnalytics.enabled())
          return response.code(502).send({
            error:
              'Nod couldn’t add your choices to analytics. Try again, or continue without sharing them.',
          });
      }
      return { ok: true };
    });
    app.post('/api/onboarding/updates-email', async (request, response) => {
      const { email } = updatesEmailInput.parse(request.body);
      response.header('cache-control', 'no-store');
      if (!options.updatesEmail)
        return response
          .code(404)
          .send({ error: 'Email updates aren’t available in this version of Nod.' });
      if (!options.updatesEmail.enabled())
        return response
          .code(403)
          .send({ error: 'Turn on Share usage data before signing up for updates.' });
      const saved = await options.updatesEmail.submit(email).catch(() => false);
      if (!options.updatesEmail.enabled())
        return response.code(409).send({
          error:
            'Sharing was turned off while submitting. Your email may already have been saved. Use Send feedback to request deletion.',
        });
      if (!saved)
        return response
          .code(502)
          .send({ error: 'Nod couldn’t sign you up for updates. Try again later.' });
      return { ok: true };
    });
  }

  return { available: Boolean(options.updatesEmail), registerRoutes };
}
