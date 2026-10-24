import type { AppsWorld } from './world/apps.ts';
import type { Site } from './world/sites.ts';
import type { Run } from './trace.ts';
import type { Session } from './session.ts';

export type Capability =
  | 'apps'
  | 'browser'
  | 'vault'
  | 'files'
  | 'research'
  | 'memory'
  | 'schedules'
  | 'approvals'
  | 'progress'
  | 'long-running';

export type FailureClass =
  | 'intent'
  | 'tool'
  | 'reasoning'
  | 'hallucination'
  | 'overcaution'
  | 'unsafe'
  | 'scope'
  | 'incomplete'
  | 'format';

export interface World {
  notificationRule?: string;
  rules?: string;
  apps?: AppsWorld;
  sites?: Record<string, Site>;
  logins?: Array<{
    label: string;
    origin: string;
    username: string;
    password: string;
    authenticatorKey?: string;
  }>;
  cards?: Array<{
    label: string;
    cardholder: string;
    cardNumber: string;
    expiryMonth: number;
    expiryYear: number;
    securityCode?: string;
  }>;
}

export interface Answer {
  when: RegExp;
  say: string;
}

export interface UserScript {
  answers?: Answer[];
  approve?: boolean | ((action: string, args: unknown) => boolean);
  approvalReplies?: string[];
  secrets?:
    | string[]
    | ((question: string, world: any, kind: 'otp' | 'payment' | 'password') => string | undefined);
  signIn?: { username: string; password: string };
  signInMethod?: string;
  persona?: string;
}

export interface Verdict {
  pass: boolean;
  evidence?: string;
}

interface Meta {
  id: string;
  group?: 'task' | 'product';
  required: boolean;
  aspect: 'process' | 'outcome';
  failure: FailureClass;
  otherwise?: string;
}

export type Expectation =
  | (Meta & { kind: 'check'; check(run: Run): Verdict | Promise<Verdict> })
  | (Meta & { kind: 'judge'; criterion: string });

export interface Scenario<W extends World = World> {
  id: string;
  title: string;
  linear?: string;
  capabilities: Capability[];
  tier: 'pr' | 'full' | 'release' | 'live' | 'canary';
  complexity: 'simple' | 'medium' | 'complex';
  stance: 'regression' | 'gap';
  seconds: number;
  timeZone?: string;
  window?: { from: number; to: number };
  calibration?: 'pending';
  user: UserScript;
  world(clock: { now(): number }): W;
  play(session: Session, world: W): Promise<void>;
  completion?(world: W): Expectation;
  expect(world: W): Expectation[];
  evidence?(run: Run, world: W): string;
}

export function scenario<W extends World>(definition: Scenario<W>) {
  return definition as unknown as Scenario;
}

interface Options {
  required?: boolean;
  aspect?: 'process' | 'outcome';
  failure?: FailureClass;
  otherwise?: string;
}

export const check = (
  id: string,
  test: (run: Run) => boolean | Verdict | Promise<boolean | Verdict>,
  options: Options = {},
): Expectation => ({
  id,
  kind: 'check',
  required: options.required ?? true,
  aspect: options.aspect ?? 'outcome',
  failure: options.failure ?? 'incomplete',
  otherwise: options.otherwise,
  async check(run) {
    const result = await test(run);
    return typeof result === 'boolean' ? { pass: result } : result;
  },
});

export const judge = (id: string, criterion: string, options: Options = {}): Expectation => ({
  id,
  kind: 'judge',
  required: options.required ?? true,
  aspect: options.aspect ?? 'outcome',
  failure: options.failure ?? 'reasoning',
  criterion,
});
