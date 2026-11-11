import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { sourceAnalyticsVersion } from '../scripts/source-version.ts';
import { runProcess } from '../src/providers/process.ts';
import { createN8nOnboardingEmail } from '../src/providers/n8n/onboarding-email.ts';
import {
  analyticsModel,
  createAnalytics,
  type AnalyticsDelivery,
} from '../src/server/analytics.ts';
import { analyticsEvent } from '../src/server/analytics-events.ts';
import { captureConnectionInventory } from '../src/server/analytics-connections.ts';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import {
  profileJobs,
  profileRoles,
  updatesEmailConsent,
  type OnboardingProfile,
} from '../src/shared/onboarding.ts';
import {
  legacyOnboardingChoiceProperties,
  onboardingPersonProperties,
  onboardingProfileAnswers,
} from '../src/shared/onboarding-analytics.ts';

test('source analytics version uses explicit values or a clean checkout revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-analytics-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runGit = (args: string[]) =>
    promisify(execFile)('git', ['-C', root, ...args], { timeout: 5000 });
  await runGit(['init', '--quiet']);
  await runGit(['config', 'user.name', 'Nod test']);
  await runGit(['config', 'user.email', 'nod@example.test']);
  const file = join(root, 'sample.txt');
  await writeFile(file, 'original');
  await runGit(['add', 'sample.txt']);
  await runGit(['commit', '--quiet', '-m', 'Initial']);
  const revision = (await runGit(['rev-parse', 'HEAD'])).stdout.trim();

  assert.equal(await sourceAnalyticsVersion(root, true), revision);
  assert.equal(await sourceAnalyticsVersion(root, false), undefined);
  assert.equal(await sourceAnalyticsVersion(root, true, '1.2.3', '4.5.6'), '1.2.3');
  assert.equal(await sourceAnalyticsVersion(root, true, undefined, '4.5.6'), '4.5.6');
  assert.equal(await sourceAnalyticsVersion(root, true, '', ''), revision);
  assert.equal(await sourceAnalyticsVersion(root, true, '   ', '4.5.6'), '4.5.6');
  const copied = join(root, 'copied-nod');
  await mkdir(copied);
  await writeFile(join(copied, 'sample.txt'), 'copied');
  await runGit(['add', 'copied-nod/sample.txt']);
  await runGit(['commit', '--quiet', '-m', 'Add copied source']);
  assert.equal(await sourceAnalyticsVersion(copied, true), undefined);
  await writeFile(file, 'modified');
  assert.equal(await sourceAnalyticsVersion(root, true), undefined);
  assert.equal(await sourceAnalyticsVersion(join(root, 'missing'), true), undefined);
});

test('onboarding email delivery sends consent and fixed answers without typed answers', async () => {
  const requests: { url: string; headers: Headers; body: string }[] = [];
  let accepted = true;
  const delivery = createN8nOnboardingEmail({
    url: 'https://internal.example.test/webhook/nod/onboarding-updates',
    request: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return Response.json({ ok: accepted }, { status: accepted ? 200 : 503 });
    },
  });
  assert.equal(delivery.configured, true);
  const signal = new AbortController().signal;
  const saved = await delivery.submit(
    {
      email: 'owner@example.test',
      profile: Object.assign(
        onboardingPersonProperties({
          scope: 'work',
          roles: ['agency', 'engineering'],
          roleText: 'Private synthetic role',
          whoFor: 'clients',
          companySize: '2_10',
          jobs: ['email', 'meetings'],
          jobsText: 'Private synthetic task',
        }),
        { roleText: 'Private synthetic role', jobsText: 'Private synthetic task' },
      ),
    },
    signal,
  );
  assert.equal(saved, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://internal.example.test/webhook/nod/onboarding-updates');
  assert.equal(requests[0]?.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(requests[0]!.body), {
    version: 1,
    email: 'owner@example.test',
    consent: true,
    consent_version: updatesEmailConsent.version,
    consent_text: updatesEmailConsent.text,
    consent_privacy_url: updatesEmailConsent.privacyUrl,
    profile: {
      onboarding_profile_completed: true,
      onboarding_scope: 'work',
      onboarding_roles: ['agency', 'engineering', 'other'],
      onboarding_who_for: 'clients',
      onboarding_company_size: '2_10',
      onboarding_jobs: ['email', 'meetings', 'other'],
    },
  });
  assert.equal(requests[0]!.body.includes('Private synthetic'), false);
  accepted = false;
  assert.equal(await delivery.submit({ email: 'owner@example.test' }, signal), false);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await delivery.submit({ email: 'owner@example.test' }, aborted.signal), false);
  assert.equal(requests.length, 2);
  assert.equal(createN8nOnboardingEmail({}).configured, false);
  assert.throws(() =>
    createN8nOnboardingEmail({
      url: 'http://internal.example.test/webhook/nod/onboarding-updates',
    }),
  );
});

test('usage sharing captures bounded events without recording screens or reviving old consent', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><div>PRIVATE_SCREEN_CANARY</div>',{url:'https://private-host.example.test/settings?secret=PRIVATE_URL_CANARY#PRIVATE_FRAGMENT_CANARY'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document});
const frames=new Map();let nextFrame=0;
globalThis.requestAnimationFrame=callback=>{frames.set(++nextFrame,callback);return nextFrame};
globalThis.cancelAnimationFrame=id=>frames.delete(id);
const flushFrames=()=>{for(const [id,callback] of frames){frames.delete(id);callback(0)}};
const sent=[];const captured=[];const configurations=[];let recordingStarts=0;let remoteLoads=0;
const client={
 init(key,options){this.token=key;this.options=options;configurations.push(options);options.loaded?.()},
 capture(event,properties={}){const value=this.options.before_send({event,properties});if(value){captured.push(value);this._send_request({url:this.options.api_host+'/e/',data:[value]})}return value},
 _send_request(request){sent.push(request)},
 _retryQueue:{retriableRequest(request){sent.push(request)},unload(){},resume(){}},
 _requestQueue:{unload(){}},
 reset(){},
 set_config(options){this.options={...this.options,...options};configurations.push(this.options)},
 stopSessionRecording(){},
 startSessionRecording(){recordingStarts++},
 _remoteConfigLoader:{load(){remoteLoads++}},
};
const analytics=await import('./src/web/lib/analytics.ts');
const {setRequestAccount}=await import('./src/web/lib/api.ts');
const {setAnalyticsClient,configureAnalytics,capturePageview,captureAnalytics,analyticsForCurrentSession}=analytics;
const checks=[];const check=(id,pass)=>checks.push({id,pass});
const appOpens=()=>captured.filter(event=>event.event==='app_opened');
const configuration={enabled:true,distinctId:'local:synthetic-owner-one',environment:'production',appVersion:'1.2.3'};
setRequestAccount('synthetic-owner-one');setAnalyticsClient(client);configureAnalytics({...configuration,enabled:false,distinctId:null},'web');flushFrames();
check('AO-no-consent',appOpens().length===0);
configureAnalytics({...configuration,distinctId:null},'web');flushFrames();
check('AO-no-id',appOpens().length===0);
configureAnalytics(configuration,'web');flushFrames();
check('AO-first',appOpens().length===1&&appOpens()[0].properties.route==='/settings'&&appOpens()[0].properties.surface==='web'&&appOpens()[0].properties.environment==='production'&&appOpens()[0].properties.app_version==='1.2.3');
configureAnalytics(configuration,'web');flushFrames();
check('AO-no-refresh-duplicate',appOpens().length===1);
check('NR1-config',client.options.disable_session_recording===true&&client.options.disable_external_dependency_loading===true);
client._send_request({url:client.options.api_host+'/flags/?v=2',method:'POST',data:{token:client.token,distinct_id:configuration.distinctId}});
client._send_request({url:client.options.api_host+'/array/'+client.token+'/config',method:'GET'});
check('NR1-flags',sent.length===1);
capturePageview(window.location.href);
check('NR4-pageview',sent.length===2&&sent[1].data[0].event==='$pageview'&&sent[1].data[0].properties.$current_url==='https://app.example/settings');
check('NE1-schema',sent[1].data[0].properties.analytics_schema==='v4');
const snapshot={event:'$snapshot',properties:{$snapshot_data:[{data:{textContent:'PRIVATE_SCREEN_CANARY'}}],$snapshot_bytes:20,$snapshot_source:'web'}};
check('NR2-snapshot',client.options.before_send(snapshot)===null);
check('NR2-unknown',client.options.before_send({event:'$autocapture',properties:{text:'PRIVATE_SCREEN_CANARY'}})===null);
const event=client.capture('settings_viewed',{
 tab:'general',
 $session_id:'synthetic-session',$window_id:'synthetic-window',
 $snapshot_data:[{data:{textContent:'PRIVATE_SCREEN_CANARY'}}],$snapshot_bytes:20,$snapshot_source:'web',
 $recording_status:'active',$sdk_debug_rrweb_attached:true,$session_recording_start_reason:'recording_initialized',
 $sdk_debug_replay_internal_buffer_length:1,$sdk_debug_replay_flushed_size:20,
 label:'PRIVATE_SCREEN_CANARY',url:window.location.href,
});
assert.ok(event,'The product-neutral settings_viewed event must be captured');
check('NR3-bounded',event.properties.tab==='general'&&!Object.keys(event.properties).some(key=>/snapshot|recording|rrweb|sdk_debug_replay/.test(key)));
check('NR3-session',event.properties.$session_id==='synthetic-session'&&event.properties.$window_id==='synthetic-window');
for(const [path,route] of [
 ['https://private-host.example.test/payments/private-id?code=PRIVATE_URL_CANARY#PRIVATE_FRAGMENT_CANARY','/payments'],
 ['/credentials/private-id?key=PRIVATE_URL_CANARY','/credentials'],
 ['/prepared/00000000-0000-4000-8000-000000000705?token=PRIVATE_URL_CANARY','/prepared'],
]){
 capturePageview(path);
 check('NR4-'+route,sent.at(-1).data[0].properties.$current_url==='https://app.example'+route);
}
const staleCapture=analyticsForCurrentSession();
const queued=client.options.before_send({event:'settings_viewed',properties:{tab:'memory'}});
configureAnalytics(undefined);
const before=sent.length;
captureAnalytics('settings_viewed',{tab:'general'});
client._send_request({url:client.options.api_host+'/e/',data:[queued]});
check('NR5-disabled',sent.length===before&&client.options.before_send(snapshot)===null);
configureAnalytics(configuration,'web');flushFrames();
check('AO-no-consent-duplicate',appOpens().length===1);
staleCapture('settings_viewed',{tab:'memory'});
client._send_request({url:client.options.api_host+'/e/',data:[queued]});
client._retryQueue.retriableRequest({url:client.options.api_host+'/e/',data:[queued]});
check('NR5-stale',sent.length===before);
captureAnalytics('settings_viewed',{tab:'models'});
check('NR5-current',sent.length===before+1&&sent.at(-1).data[0].properties.tab==='models');
window.history.replaceState(null,'','/browser');
setRequestAccount('synthetic-owner-two');configureAnalytics({...configuration,distinctId:'local:synthetic-owner-two'},'desktop');flushFrames();
check('AO-no-secondary-route',appOpens().length===1);
window.history.replaceState(null,'','/apps');
capturePageview('/apps');
check('AO-primary-after-secondary',appOpens().length===2&&appOpens()[1].properties.route==='/apps'&&appOpens()[1].properties.surface==='desktop');
check('NR1-owner-change',sent.at(-1).data[0].properties.surface==='desktop'&&configurations.every(options=>options.disable_session_recording===true));
window.opener={};
setRequestAccount('synthetic-owner-three');configureAnalytics({...configuration,distinctId:'local:synthetic-owner-three'},'desktop');flushFrames();
check('AO-no-secondary-window',appOpens().length===2);
window.opener=null;
check('NR1-never-started',recordingStarts===0&&remoteLoads===0);
check('NR3-no-replay-api',!Object.hasOwn(analytics,'analyticsReplaySession'));
check('NR4-no-private-content',!JSON.stringify(sent).includes('PRIVATE_')&&!JSON.stringify(sent).includes('private-host'));
configureAnalytics(undefined);dom.window.close();
console.log(JSON.stringify({checks,eventCount:captured.length}));
assert.ok(checks.every(check=>check.pass),checks.filter(check=>!check.pass).map(check=>check.id).join(', '));
`,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('desktop first-open capture follows consent changes while its bridge is pending', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html>',{url:'https://app.example/onboarding'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document});
const calls=[];const captured=[];let resolveFirst;let accepted=0;let nativeFallback=false;let nativeMarker=false;
const first=new Promise(resolve=>{resolveFirst=resolve});
window.nodDesktop={
 getSettings:async()=>({}),
 takeAppOpening(consented,distinctId){
  calls.push({consented,distinctId});
  if(!consented)return Promise.resolve(null);
  if(++accepted===1)return first;
  if(nativeFallback)return Promise.resolve({openedAt:1700000002000,uuid:accepted===3?'00000000-0000-4000-8000-000000000004':'00000000-0000-4000-8000-000000000006',entry:'native_setup',...(nativeMarker?{serverConnectionTelemetryAvailable:true}:{})});
  return Promise.resolve({openedAt:1700000001000,uuid:'00000000-0000-4000-8000-000000000002',entry:'app_ui'});
 },
};
const client={
 init(_key,options){this.options=options;options.loaded?.()},
 capture(event,properties,options){
  const value=this.options.before_send({event,properties,uuid:options?.uuid,timestamp:options?.timestamp});
  if(value)captured.push(value);
  return value;
 },
 _send_request(){},reset(){},set_config(options){this.options={...this.options,...options}},
};
const {setAnalyticsClient,configureAnalytics}=await import('./src/web/lib/analytics.ts');
const {setRequestAccount}=await import('./src/web/lib/api.ts');
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(setImmediate)};
const distinctId='local:00000000-0000-4000-8000-000000000001';
const configuration={enabled:true,distinctId,environment:'production',appVersion:'1.2.3'};
setRequestAccount('owner-one');setAnalyticsClient(client);
configureAnalytics(configuration,'desktop');
configureAnalytics(configuration,'desktop');
await settle();
assert.deepEqual(calls.map(call=>call.consented),[true]);
configureAnalytics({...configuration,enabled:false,distinctId:null},'desktop');
configureAnalytics(configuration,'desktop');
resolveFirst({openedAt:1700000000000,uuid:'00000000-0000-4000-8000-000000000003',entry:'native_setup'});
await settle();
assert.deepEqual(calls.map(call=>call.consented),[true,false,true]);
assert.equal(captured.length,1);
assert.equal(captured[0].properties.entry,'app_ui');
assert.equal(captured[0].properties.route,'/onboarding');
assert.equal(captured[0].uuid,'00000000-0000-4000-8000-000000000002');
assert.equal(new Date(captured[0].timestamp).getTime(),1700000001000);
nativeFallback=true;
window.history.replaceState(null,'','/apps');
setRequestAccount('owner-two');
configureAnalytics({...configuration,distinctId:'local:00000000-0000-4000-8000-000000000005'},'desktop');
await settle();
assert.equal(captured.length,2);
assert.equal(captured[1].properties.entry,'native_setup');
assert.equal(captured[1].properties.route,'/onboarding');
assert.equal(captured[1].properties.server_connection_telemetry_available,undefined);
assert.equal(captured[1].uuid,'00000000-0000-4000-8000-000000000004');
nativeMarker=true;
setRequestAccount('owner-three');
configureAnalytics({...configuration,distinctId:'local:00000000-0000-4000-8000-000000000007'},'desktop');
await settle();
assert.equal(captured.length,3);
assert.equal(captured[2].properties.entry,'native_setup');
assert.equal(captured[2].properties.server_connection_telemetry_available,true);
assert.equal(captured[2].uuid,'00000000-0000-4000-8000-000000000006');
configureAnalytics(undefined,'desktop');dom.window.close();
`,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('the browser analytics bundle contains no session recorder implementation', async () => {
  const bundled = await build({
    entryPoints: ['src/web/lib/analytics-client.ts'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
  });
  assert.ok(Object.keys(bundled.metafile.inputs).some((path) => path.includes('posthog-js')));
  assert.deepEqual(
    Object.keys(bundled.metafile.inputs).filter((path) => /posthog-recorder|rrweb/.test(path)),
    [],
  );
});

test('server analytics ignore obsolete replay links while preserving permitted events', async () => {
  const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
  const analytics = await createAnalytics({
    provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
    environment: 'production',
    dataRoot: '.',
    installationId: randomUUID(),
  });
  try {
    analytics.setUsageData('synthetic-owner', true);
    analytics.capture('synthetic-owner', { event: 'chat_stopped' }, {
      replaySessionId: randomUUID(),
    } as AnalyticsDelivery);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].event, 'chat_stopped');
    assert.equal(captured[0].properties.analytics_schema, 'v4');
    assert.equal(captured[0].properties.$session_id, undefined);
    assert.equal(Object.hasOwn(analytics, 'linkReplay'), false);
    assert.equal(Object.hasOwn(analytics, 'replaySession'), false);
  } finally {
    await analytics.shutdown();
  }
});

test('About you keeps event choices independent and groups person answers by question', () => {
  const all: OnboardingProfile = {
    scope: 'personal',
    roles: profileRoles.map(({ id }) => id).reverse(),
    roleText: 'SYNTHETIC_PRIVATE_ROLE',
    whoFor: 'both',
    jobs: profileJobs.map(({ id }) => id).reverse(),
    jobsText: 'SYNTHETIC_PRIVATE_JOB',
  };
  const event = onboardingProfileAnswers(all);
  const person: Record<string, unknown> = onboardingPersonProperties(all);
  const roleKeys = profileRoles.map(({ id }) => `role_${id}`);
  const jobKeys = profileJobs.map(({ id }) => `job_${id}`);

  assert.equal(
    Object.keys(event).filter((key) => key.startsWith('role_')).length,
    roleKeys.length + 1,
  );
  assert.equal(
    Object.keys(event).filter((key) => key.startsWith('job_')).length,
    jobKeys.length + 1,
  );
  assert.deepEqual(
    Object.keys(person).sort(),
    [
      'onboarding_profile_completed',
      'onboarding_scope',
      'onboarding_roles',
      'onboarding_who_for',
      'onboarding_company_size',
      'onboarding_jobs',
    ].sort(),
  );
  for (const key of [...roleKeys, ...jobKeys, 'role_other', 'job_other']) {
    assert.equal(event[key as keyof typeof event], true, key);
  }
  assert.equal(person.onboarding_profile_completed, true);
  assert.equal(person.onboarding_scope, 'personal');
  assert.deepEqual(person.onboarding_roles, [...profileRoles.map(({ id }) => id), 'other']);
  assert.equal(person.onboarding_who_for, 'both');
  assert.equal(person.onboarding_company_size, 'not_asked');
  assert.deepEqual(person.onboarding_jobs, [...profileJobs.map(({ id }) => id), 'other']);
  assert.ok(!JSON.stringify({ event, person }).includes('SYNTHETIC_PRIVATE'));

  for (const selected of profileRoles) {
    const profile: OnboardingProfile = { scope: 'personal', roles: [selected.id], jobs: [] };
    const answer = onboardingProfileAnswers(profile);
    assert.deepEqual(onboardingPersonProperties(profile).onboarding_roles, [selected.id]);
    for (const option of profileRoles)
      assert.equal(
        answer[`role_${option.id}` as keyof typeof answer],
        option.id === selected.id,
        `${selected.id} → ${option.id}`,
      );
  }
  for (const selected of profileJobs) {
    const profile: OnboardingProfile = { roles: [], jobs: [selected.id] };
    const answer = onboardingProfileAnswers(profile);
    assert.deepEqual(onboardingPersonProperties(profile).onboarding_jobs, [selected.id]);
    for (const option of profileJobs)
      assert.equal(
        answer[`job_${option.id}` as keyof typeof answer],
        option.id === selected.id,
        `${selected.id} → ${option.id}`,
      );
  }
});

test('onboarding answers and updates email update one profile only while usage sharing is enabled', async () => {
  const profiles: Array<{
    distinctId: string;
    properties: Record<string, string | number | boolean | string[]>;
    unset?: readonly string[];
  }> = [];
  let waitForOptOut = false;
  const installationId = randomUUID();
  const analytics = await createAnalytics({
    provider: {
      capture: () => {},
      setPersonProperties: async (input, signal) => {
        profiles.push(input);
        if (waitForOptOut)
          return new Promise<boolean>((resolve) => {
            signal.addEventListener('abort', () => resolve(false), { once: true });
          });
        return !signal.aborted;
      },
      shutdown: async () => {},
    },
    environment: 'development',
    dataRoot: '.',
    installationId,
  });
  try {
    const owner = 'synthetic-owner';
    const full: OnboardingProfile = {
      scope: 'work',
      roles: ['agency', 'engineering'],
      roleText: 'SYNTHETIC_PRIVATE_ROLE',
      whoFor: 'clients',
      companySize: '2_10',
      jobs: ['email', 'meetings'],
      jobsText: 'SYNTHETIC_PRIVATE_JOB',
    };
    assert.equal(analytics.personProfileAvailable, true);
    assert.equal(await analytics.setOnboardingProfileAnswers(owner, full), false);
    assert.equal(await analytics.setUpdatesEmail(owner, 'owner@example.test'), false);
    assert.equal(profiles.length, 0);
    analytics.setUsageData(owner, true);
    assert.equal(await analytics.setOnboardingProfileAnswers(owner, full), true);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.distinctId, 'local:' + installationId);
    assert.deepEqual(profiles[0]?.unset, legacyOnboardingChoiceProperties);
    assert.equal(profiles[0]?.properties.onboarding_profile_completed, true);
    assert.equal(profiles[0]?.properties.onboarding_scope, 'work');
    assert.deepEqual(profiles[0]?.properties.onboarding_roles, ['agency', 'engineering', 'other']);
    assert.equal(profiles[0]?.properties.onboarding_who_for, 'clients');
    assert.equal(profiles[0]?.properties.onboarding_company_size, '2_10');
    assert.deepEqual(profiles[0]?.properties.onboarding_jobs, ['email', 'meetings', 'other']);
    assert.equal(profiles[0]?.properties.email, undefined);
    assert.equal(profiles[0]?.properties.nod_updates_email_consent, undefined);
    assert.ok(!JSON.stringify(profiles[0]).includes('SYNTHETIC_PRIVATE'));
    assert.equal(await analytics.setUpdatesEmail(owner, 'owner@example.test'), true);
    assert.equal(profiles.length, 2);
    assert.equal(profiles[1]?.distinctId, 'local:' + installationId);
    assert.equal(profiles[1]?.unset, undefined);
    assert.equal(profiles[1]?.properties.email, 'owner@example.test');
    assert.equal(profiles[1]?.properties.nod_updates_email_consent, true);
    assert.equal(profiles[1]?.properties.nod_updates_email_consent_version, 2);
    assert.equal(profiles[1]?.properties.nod_updates_email_consent_text, updatesEmailConsent.text);
    assert.equal(
      profiles[1]?.properties.nod_updates_email_consent_privacy_url,
      updatesEmailConsent.privacyUrl,
    );
    assert.ok(
      !Number.isNaN(Date.parse(String(profiles[1]?.properties.nod_updates_email_consent_at))),
    );
    assert.equal(
      await analytics.setOnboardingProfileAnswers(owner, {
        scope: 'personal',
        roles: [],
        jobs: [],
      }),
      true,
    );
    assert.equal(profiles[2]?.properties.onboarding_scope, 'personal');
    assert.deepEqual(profiles[2]?.properties.onboarding_roles, ['skipped']);
    assert.equal(profiles[2]?.properties.onboarding_who_for, 'not_asked');
    assert.equal(profiles[2]?.properties.onboarding_company_size, 'not_asked');
    assert.deepEqual(profiles[2]?.properties.onboarding_jobs, ['skipped']);
    assert.deepEqual(profiles[2]?.unset, legacyOnboardingChoiceProperties);
    assert.equal(await analytics.setOnboardingProfileAnswers(owner, { roles: [], jobs: [] }), true);
    assert.equal(profiles[3]?.properties.onboarding_scope, 'skipped');
    assert.deepEqual(profiles[3]?.properties.onboarding_roles, ['skipped']);
    assert.equal(profiles[3]?.properties.onboarding_who_for, 'not_asked');
    assert.equal(profiles[3]?.properties.onboarding_company_size, 'skipped');
    assert.deepEqual(profiles[3]?.properties.onboarding_jobs, ['skipped']);
    assert.equal(await analytics.setUpdatesEmail('another-owner', 'other@example.test'), false);
    assert.equal(await analytics.setOnboardingProfileAnswers('another-owner', full), false);
    assert.equal(profiles.length, 4);
    waitForOptOut = true;
    const pending = analytics.setOnboardingProfileAnswers(owner, full);
    analytics.setUsageData(owner, false);
    assert.equal(await pending, false);
    assert.equal(await analytics.setOnboardingProfileAnswers(owner, full), false);
    assert.equal(await analytics.setUpdatesEmail(owner, 'owner@example.test'), false);
    assert.equal(profiles.length, 5);

    waitForOptOut = false;
    analytics.setUsageData(owner, true);
    const consent = analytics.consent(owner);
    const fixed = onboardingPersonProperties(full);
    assert.equal(await analytics.setOnboardingProfileProperties(owner, fixed, consent), true);
    assert.deepEqual(profiles[5]?.properties, fixed);
    assert.equal(
      await analytics.setUpdatesEmail(
        owner,
        'owner@example.test',
        '2026-11-10T10:00:00.000Z',
        consent,
      ),
      true,
    );
    assert.equal(profiles.length, 7);
    analytics.setUsageData(owner, false);
    analytics.setUsageData(owner, true);
    assert.equal(await analytics.setOnboardingProfileProperties(owner, fixed, consent), false);
    assert.equal(
      await analytics.setUpdatesEmail(
        owner,
        'owner@example.test',
        '2026-11-10T10:01:00.000Z',
        consent,
      ),
      false,
    );
    assert.equal(profiles.length, 7);
  } finally {
    await analytics.shutdown();
  }
});

test('onboarding answers and consented contact stay queryable by separate installation identities', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {createAnalytics} from './src/server/analytics.ts';
import {createPostHogAnalytics} from './src/providers/posthog/analytics.ts';
import {posthogConfig} from './src/shared/analytics.ts';
import {legacyOnboardingChoiceProperties} from './src/shared/onboarding-analytics.ts';

const dom=new JSDOM('<!doctype html>',{url:'https://app.example/onboarding'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document});
const {setAnalyticsClient,configureAnalytics,captureAnalytics}=await import('./src/web/lib/analytics.ts');
const captured=[];
const personRequests=[];
globalThis.fetch=async (url,options)=>{
  assert.equal(String(url),posthogConfig.host+'/i/v0/e/');
  personRequests.push(JSON.parse(String(options.body)));
  return Response.json({status:'Ok'});
};
const client={
  init(_key,options){this.options=options;this.distinctId=options.bootstrap.distinctID;options.loaded?.()},
  capture(event,properties={}){
    const value=this.options.before_send({event,properties:{...properties,distinct_id:this.distinctId}});
    if(value)this._send_request({url:this.options.api_host+'/e/',data:[value]});
  },
  _send_request(request){captured.push(...request.data)},
  _retryQueue:{retriableRequest(){},unload(){},resume(){}},
  _requestQueue:{unload(){}},
  reset(options){this.distinctId=options.bootstrap.distinctID},
  set_config(options){this.options={...this.options,...options}},
};
setAnalyticsClient(client);
const ids=[randomUUID(),randomUUID(),randomUUID()];
const owners=['synthetic-with-email','synthetic-without-email','synthetic-opted-out'];
const analytics=await Promise.all(ids.map(installationId=>createAnalytics({
  provider:createPostHogAnalytics(),environment:'development',dataRoot:'.',installationId,
})));
const [withEmail,withoutEmail,optedOut]=analytics;
withEmail.setUsageData(owners[0],true);
withoutEmail.setUsageData(owners[1],true);
const fullAnswers={
  scope:'work',role_owner:true,role_freelance:false,role_agency:false,
  role_engineering:true,role_product:false,role_gtm:false,role_manager:false,
  role_student:false,role_not_working:false,role_other:true,who_for:'clients',
  company_size:'2_10',job_email:true,job_calendar:true,job_meetings:true,
  job_errands:false,job_research:true,job_routines:false,job_other:true,
};
const fullProfile={
  scope:'work',roles:['owner','engineering'],roleText:'SYNTHETIC_PRIVATE_ROLE',
  whoFor:'clients',companySize:'2_10',jobs:['email','calendar','meetings','research'],
  jobsText:'SYNTHETIC_PRIVATE_JOB',
};
const noEmailProfile={
  scope:'work',roles:['agency','engineering'],whoFor:'me',companySize:'11_100',
  jobs:['email','meetings','research','routines'],
};
try{
  configureAnalytics(withEmail.configuration(owners[0]),'web');
  assert.equal(await withEmail.setOnboardingProfileAnswers(owners[0],fullProfile),true);
  captureAnalytics('onboarding_profile_answered',{
    ...fullAnswers,email:'private@example.test',roleText:'SYNTHETIC_PRIVATE_ROLE',
    jobsText:'SYNTHETIC_PRIVATE_JOB',
  });
  assert.equal(await withEmail.setUpdatesEmail(owners[0],'researcher-a@example.test'),true);
  captureAnalytics('onboarding_updates_email_submitted');

  configureAnalytics(withoutEmail.configuration(owners[1]),'web');
  assert.equal(await withoutEmail.setOnboardingProfileAnswers(owners[1],noEmailProfile),true);
  captureAnalytics('onboarding_profile_answered',{
    ...fullAnswers,role_owner:false,role_agency:true,role_other:false,
    who_for:'me',company_size:'11_100',job_calendar:false,job_routines:true,job_other:false,
  });

  configureAnalytics(optedOut.configuration(owners[2]),'web');
  captureAnalytics('onboarding_profile_answered',fullAnswers);
  assert.equal(await optedOut.setOnboardingProfileAnswers(owners[2],fullProfile),false);
  assert.equal(await optedOut.setUpdatesEmail(owners[2],'researcher-c@example.test'),false);

  const eventsById=Map.groupBy(captured,event=>event.properties.distinct_id);
  const [firstId,secondId,thirdId]=ids.map(id=>'local:'+id);
  assert.deepEqual([...eventsById.keys()],[firstId,secondId]);
  const first=eventsById.get(firstId);
  const second=eventsById.get(secondId);
  assert.deepEqual(first.map(event=>event.event),[
    'app_opened','onboarding_profile_answered','onboarding_updates_email_submitted',
  ]);
  assert.deepEqual(second.map(event=>event.event),['app_opened','onboarding_profile_answered']);
  for(const [key,value] of Object.entries(fullAnswers))
    assert.equal(first[1].properties[key],value,key);
  assert.equal(second[1].properties.role_agency,true);
  assert.equal(second[1].properties.who_for,'me');
  assert.equal(second[1].properties.company_size,'11_100');
  assert.equal(eventsById.has(thirdId),false);
  assert.equal(personRequests.length,3);
  assert.ok(personRequests.every(request=>request.event==='$set'));
  assert.deepEqual(personRequests.map(request=>request.distinct_id),[firstId,firstId,secondId]);
  const personKeys=[
    'onboarding_profile_completed','onboarding_scope','onboarding_roles',
    'onboarding_who_for','onboarding_company_size','onboarding_jobs',
  ];
  assert.deepEqual(Object.keys(personRequests[0].properties.$set).sort(),personKeys.sort());
  assert.equal(personRequests[0].properties.$set.onboarding_profile_completed,true);
  assert.equal(personRequests[0].properties.$set.onboarding_scope,'work');
  assert.deepEqual(personRequests[0].properties.$set.onboarding_roles,['owner','engineering','other']);
  assert.equal(personRequests[0].properties.$set.onboarding_who_for,'clients');
  assert.equal(personRequests[0].properties.$set.onboarding_company_size,'2_10');
  assert.deepEqual(personRequests[0].properties.$set.onboarding_jobs,['email','calendar','meetings','research','other']);
  assert.deepEqual(personRequests[0].properties.$unset,legacyOnboardingChoiceProperties);
  assert.equal(personRequests[0].properties.$set.email,undefined);
  assert.equal(personRequests[0].properties.$set.nod_updates_email_consent,undefined);
  assert.equal(personRequests[1].properties.$set.email,'researcher-a@example.test');
  assert.equal(personRequests[1].properties.$set.nod_updates_email_consent,true);
  assert.equal(personRequests[1].properties.$unset,undefined);
  assert.equal(personRequests[2].properties.$set.onboarding_scope,'work');
  assert.deepEqual(personRequests[2].properties.$set.onboarding_roles,['agency','engineering']);
  assert.equal(personRequests[2].properties.$set.onboarding_who_for,'me');
  assert.equal(personRequests[2].properties.$set.onboarding_company_size,'11_100');
  assert.deepEqual(personRequests[2].properties.$set.onboarding_jobs,['email','meetings','research','routines']);
  assert.deepEqual(personRequests[2].properties.$unset,legacyOnboardingChoiceProperties);
  assert.equal(personRequests[2].properties.$set.email,undefined);
  assert.equal(personRequests[2].properties.$set.nod_updates_email_consent,undefined);
  assert.equal(JSON.stringify(captured).includes('example.test'),false);
  assert.equal(JSON.stringify(captured).includes('SYNTHETIC_PRIVATE'),false);
  assert.equal(JSON.stringify(personRequests).includes('SYNTHETIC_PRIVATE'),false);
  assert.equal(JSON.stringify(personRequests).includes(thirdId),false);
}finally{
  configureAnalytics(undefined);
  await Promise.all(analytics.map(entry=>entry.shutdown()));
  dom.window.close();
}
`,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('turn analytics keep the actual agent provider and remove stale model details', async (t) => {
  for (const [provider, model, expected] of [
    ['openai', 'gpt-6-luna', { provider: 'openai', model: 'gpt-6-luna' }],
    ['compatible', 'private-model-canary', { provider: 'compatible', model: 'custom' }],
    ['private-provider-canary', 'private-model-canary', { provider: 'other', model: 'custom' }],
    ['openai', undefined, { provider: 'openai', model: undefined }],
  ] as const) {
    await t.test(`${expected.provider}/${expected.model ?? 'unknown'}`, async (t) => {
      const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
      const analytics = await createAnalytics({
        provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
        environment: 'development',
        dataRoot: '.',
        installationId: randomUUID(),
      });
      t.after(() => analytics.shutdown());
      const owner = 'synthetic-owner';
      analytics.setUsageData(owner, true);
      const initial = {
        source: 'user' as const,
        channel: 'web' as const,
        background: false,
        work_type: 'immediate' as const,
        owner_requested: true,
        ...analyticsModel('anthropic', 'claude-sonnet-4-5'),
      };
      await analytics.withRun(owner, async () => {
        analytics.capture(owner, { event: 'turn_started', properties: initial });
        analytics.capture(owner, {
          event: 'model_used',
          properties: {
            ...analyticsModel(provider, model),
            purpose: 'agent',
            outcome: 'succeeded',
            input_tokens: 20,
            output_tokens: 5,
            pricing: 'api',
          },
        });
        analytics.capture(owner, {
          event: 'model_used',
          properties: {
            provider: 'google',
            model: 'gemini-2.5-flash',
            purpose: 'memory',
            outcome: 'succeeded',
            input_tokens: 10,
            output_tokens: 2,
            pricing: 'api',
          },
        });
        analytics.capture(owner, {
          event: 'turn_completed',
          properties: { ...initial, outcome: 'succeeded', duration_ms: 10 },
        });
      });
      assert.deepEqual(
        captured.map(({ event }) => event),
        ['turn_started', 'model_used', 'model_used', 'turn_completed'],
      );
      const [started, used, memory, completed] = captured.map(({ properties }) => properties);
      assert.equal(started.provider, 'anthropic');
      assert.equal(started.model, 'claude-sonnet-4-5');
      assert.equal(memory.provider, 'google');
      for (const properties of [used, completed]) {
        assert.equal(properties.provider, expected.provider);
        assert.equal(properties.model, expected.model);
      }
      for (const properties of [started, used, memory, completed]) {
        assert.equal(properties.run_id, started.run_id);
        assert.equal(Object.hasOwn(properties, 'model_provider'), false);
      }
      assert.doesNotMatch(JSON.stringify(captured), /private-(?:provider|model)-canary/);
    });
  }
});

test('accepted owner messages do not inherit an unrelated run context', async () => {
  const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
  const analytics = await createAnalytics({
    provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
    environment: 'production',
    dataRoot: '.',
    installationId: randomUUID(),
  });
  try {
    const owner = 'synthetic-owner';
    analytics.setUsageData(owner, true);
    await analytics.withRun(owner, async () => {
      analytics.capture(owner, {
        event: 'turn_started',
        properties: {
          source: 'user',
          channel: 'web',
          background: false,
          work_type: 'immediate',
          owner_requested: true,
        },
      });
      analytics.capture(
        owner,
        {
          event: 'owner_message_accepted',
          properties: { channel: 'telegram' },
        },
        { runId: randomUUID() },
      );
    });
    assert.equal(captured.length, 2);
    assert.ok(captured[0]!.properties.run_id);
    assert.equal(Object.hasOwn(captured[1]!.properties, 'run_id'), false);
    assert.equal(Object.hasOwn(captured[1]!.properties, 'work_type'), false);
    assert.equal(captured[1]!.properties.channel, 'telegram');
  } finally {
    await analytics.shutdown();
  }
});

test('connection inventory captures zero and distinct safe app types only after a consented read', async () => {
  const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
  const analytics = await createAnalytics({
    provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
    environment: 'production',
    dataRoot: '.',
    installationId: randomUUID(),
  });
  const owner = 'synthetic-owner';
  const inventory = () => captured.filter(({ event }) => event === 'connection_inventory_observed');
  try {
    analytics.setUsageData(owner, false);
    let read = false;
    await captureConnectionInventory(analytics, owner, async () => {
      read = true;
      return [];
    });
    assert.equal(read, false);
    assert.equal(captured.length, 0);

    analytics.setUsageData(owner, true);
    await captureConnectionInventory(analytics, owner, async () => []);
    assert.deepEqual(inventory()[0]?.properties.connected_app_types, []);
    assert.equal(inventory()[0]?.properties.connected_app_type_count, 0);

    await captureConnectionInventory(analytics, owner, async () => [
      { app: 'gmail', publicApp: true, connection_method: 'managed_app' },
      { app: 'gmail', publicApp: true, connection_method: 'managed_app' },
      {
        app: 'private-service-name',
        publicApp: false,
        connection_method: 'mcp',
        endpoint: 'https://private-service.invalid',
      },
    ]);
    assert.deepEqual(inventory()[1]?.properties.connected_app_types, ['custom', 'gmail']);
    assert.equal(inventory()[1]?.properties.connected_app_type_count, 2);
    assert.doesNotMatch(JSON.stringify(captured), /private-service/);
    for (const properties of [
      { connected_app_types: ['gmail', 'gmail'], connected_app_type_count: 2 },
      { connected_app_types: ['gmail'], connected_app_type_count: 0 },
    ])
      assert.equal(
        analyticsEvent.safeParse({ event: 'connection_inventory_observed', properties }).success,
        false,
      );

    await captureConnectionInventory(analytics, owner, async () => []);
    assert.deepEqual(inventory()[2]?.properties.connected_app_types, []);
    assert.equal(inventory()[2]?.properties.connected_app_type_count, 0);

    await captureConnectionInventory(
      analytics,
      owner,
      async () => [],
      () => [],
      false,
    );
    assert.equal(inventory().length, 3);

    await assert.rejects(
      captureConnectionInventory(analytics, owner, async () => {
        throw new Error('Synthetic inventory read failure.');
      }),
    );
    assert.equal(inventory().length, 3);

    await captureConnectionInventory(analytics, owner, async () => {
      analytics.setUsageData(owner, false);
      return [];
    });
    assert.equal(inventory().length, 3);
    read = false;
    await captureConnectionInventory(analytics, owner, async () => {
      read = true;
      return [];
    });
    assert.equal(read, false);
  } finally {
    await analytics.shutdown();
  }
});

test('analytics reject the old provider field instead of accepting two contracts', () => {
  const turn = {
    source: 'user',
    channel: 'web',
    background: false,
    work_type: 'immediate',
    owner_requested: true,
  };
  for (const [event, properties] of [
    ['onboarding_completed', {}],
    ['turn_started', turn],
    ['turn_completed', { ...turn, outcome: 'succeeded', duration_ms: 10 }],
  ] as const) {
    assert.equal(
      analyticsEvent.safeParse({ event, properties: { ...properties, provider: 'openai' } })
        .success,
      true,
    );
    for (const provider of [
      { model_provider: 'openai' },
      { provider: 'openai', model_provider: 'openai' },
    ]) {
      assert.equal(
        analyticsEvent.safeParse({ event, properties: { ...properties, ...provider } }).success,
        false,
      );
    }
  }
});
