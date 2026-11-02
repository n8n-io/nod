import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { runProcess } from '../src/providers/process.ts';
import { createAnalytics, type AnalyticsDelivery } from '../src/server/analytics.ts';
import type { ProductAnalytics } from '../src/ports/analytics.ts';

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
 init(_key,options){this.options=options;configurations.push(options);options.loaded?.()},
 capture(event,properties={}){const value=this.options.before_send({event,properties});if(value){captured.push(value);this._send_request({data:[value]})}return value},
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
check('NR1-flags',client.options.advanced_disable_flags===true);
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
client._send_request({data:[queued]});
check('NR5-disabled',sent.length===before&&client.options.before_send(snapshot)===null);
configureAnalytics(configuration,'web');flushFrames();
staleCapture('settings_viewed',{tab:'memory'});
client._send_request({data:[queued]});
client._retryQueue.retriableRequest({data:[queued]});
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
