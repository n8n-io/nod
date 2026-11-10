import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { runProcess } from '../src/providers/process.ts';
import {
  analyticsModel,
  createAnalytics,
  type AnalyticsDelivery,
} from '../src/server/analytics.ts';
import { analyticsEvent } from '../src/server/analytics-events.ts';
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
const configuration={enabled:true,distinctId:'local:synthetic-owner-one',environment:'production'};
setRequestAccount('synthetic-owner-one');setAnalyticsClient(client);configureAnalytics(configuration,'web');flushFrames();
check('NR1-config',client.options.disable_session_recording===true&&client.options.disable_external_dependency_loading===true);
client._send_request({url:client.options.api_host+'/flags/?v=2',method:'POST',data:{token:client.token,distinct_id:configuration.distinctId}});
client._send_request({url:client.options.api_host+'/array/'+client.token+'/config',method:'GET'});
check('NR1-flags',sent.length===0);
capturePageview(window.location.href);
check('NR4-pageview',sent.length===1&&sent[0].data[0].event==='$pageview'&&sent[0].data[0].properties.$current_url==='https://app.example/settings');
check('NE1-schema',sent[0].data[0].properties.analytics_schema==='v4');
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
staleCapture('settings_viewed',{tab:'memory'});
client._send_request({url:client.options.api_host+'/e/',data:[queued]});
client._retryQueue.retriableRequest({url:client.options.api_host+'/e/',data:[queued]});
check('NR5-stale',sent.length===before);
captureAnalytics('settings_viewed',{tab:'models'});
check('NR5-current',sent.length===before+1&&sent.at(-1).data[0].properties.tab==='models');
setRequestAccount('synthetic-owner-two');configureAnalytics({...configuration,distinctId:'local:synthetic-owner-two'},'desktop');flushFrames();
capturePageview('/apps');
check('NR1-owner-change',sent.at(-1).data[0].properties.surface==='desktop'&&configurations.every(options=>options.disable_session_recording===true));
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
    'onboarding_profile_answered','onboarding_updates_email_submitted',
  ]);
  assert.deepEqual(second.map(event=>event.event),['onboarding_profile_answered']);
  for(const [key,value] of Object.entries(fullAnswers))
    assert.equal(first[0].properties[key],value,key);
  assert.equal(second[0].properties.role_agency,true);
  assert.equal(second[0].properties.who_for,'me');
  assert.equal(second[0].properties.company_size,'11_100');
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
