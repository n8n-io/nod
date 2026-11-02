import type { Connection } from './contracts.ts';

export const onboardingSteps = ['welcome', 'email', 'about', 'brain', 'privacy', 'join'] as const;
export const onboardingEmailProviders = ['gmail', 'outlook'] as const;
export const onboardingCalendarProviders = ['googlecalendar', 'outlook'] as const;
export const onboardingVersion = 4;
export type OnboardingStep = (typeof onboardingSteps)[number];

export const profileScopes = [
  { id: 'work', label: 'Mostly work' },
  { id: 'personal', label: 'Mostly personal life' },
  { id: 'both', label: 'Both' },
] as const;
export const profileRoles = [
  { id: 'owner', label: 'I run my own business' },
  { id: 'freelance', label: 'Freelance or consulting' },
  { id: 'agency', label: 'Agency' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'product', label: 'Product or design' },
  { id: 'gtm', label: 'Sales, marketing or ops' },
  { id: 'manager', label: 'Manager or executive' },
  { id: 'student', label: 'Student', personal: true },
  { id: 'not_working', label: 'Not working right now', personal: true },
] as const;
export const profileCompanySizes = [
  { id: 'solo', label: 'Just me' },
  { id: '2_10', label: '2–10 people' },
  { id: '11_100', label: '11–100 people' },
  { id: '101_1000', label: '101–1,000 people' },
  { id: '1000_plus', label: '1,000+ people' },
] as const;
export const profileJobs = [
  { id: 'email', label: 'Stay on top of email' },
  { id: 'calendar', label: 'Manage my calendar' },
  { id: 'follow_ups', label: 'Make sure nothing slips' },
  { id: 'errands', label: 'Handle bookings and errands online' },
  { id: 'research', label: 'Research things for me' },
  { id: 'routines', label: 'Take care of recurring tasks' },
] as const;
export const profileTextChars = 200;
export type ProfileScope = (typeof profileScopes)[number]['id'];
export type ProfileRole = (typeof profileRoles)[number]['id'];
export type ProfileCompanySize = (typeof profileCompanySizes)[number]['id'];
export type ProfileJob = (typeof profileJobs)[number]['id'];
export type OnboardingProfile = {
  scope?: ProfileScope;
  role?: ProfileRole;
  roleText?: string;
  companySize?: ProfileCompanySize;
  jobs: ProfileJob[];
  jobsText?: string;
};
export const communityLinks = {
  discord: 'https://discord.gg/n8n',
  forum: 'https://community.n8n.io/c/n8n-labs/48',
} as const;
export function connectedGmail(connection: Connection) {
  return (
    connection.slug === 'gmail' &&
    connection.status === 'connected' &&
    Boolean(connection.connectionId && connection.accountId) &&
    !connection.disconnectPending
  );
}
export function reconnectable(connection: Connection) {
  return (
    Boolean(connection.connectionId && connection.accountId) &&
    !connection.disconnectPending &&
    Boolean(connection.canReconnect) &&
    (connection.status === 'disconnected' || Boolean(connection.reconnectRequired))
  );
}
export type SuggestedTask = {
  id: string;
  title: string;
  source: string;
  kind?: 'now' | 'ongoing';
  origin?: 'learned' | 'common';
};
export type TaskSuggestions = {
  intro: string;
  tasks: SuggestedTask[];
  apps?: string[];
};
