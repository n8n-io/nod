import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { serviceEnvironment } from '../process.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import type { CommandProcess } from '../command-process.ts';

export const workspaceCommandProgram = `import os,sys,json,base64,selectors,subprocess,signal,time,threading,re,tempfile,shutil
line=sys.stdin.buffer.raw.readline(1048577)
home=None
try:
 r=json.loads(line)
 if len(line)>1048576 or not isinstance(r['args'],list) or not r['args'] or not all(isinstance(v,str) for v in r['args']): raise ValueError()
 env=r.get('environment',{})
 if not isinstance(env,dict) or len(env)>1 or not all(isinstance(k,str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}(?:TOKEN|API_KEY|SECRET|PASSWORD)',k) and isinstance(v,str) and 8<=len(v)<=8192 for k,v in env.items()): raise ValueError()
 limit=int(r['maxBytes'])
 timeout=float(r['timeoutMs'])/1000
 if not 1<=limit<=16777216 or not 0<timeout<=3600: raise ValueError()
 child_env=os.environ.copy()
 child_env.update(env)
 home=tempfile.mkdtemp(prefix='otto-cli-') if env else None
 if home:
  child_env['HOME']=home
  child_env['XDG_CONFIG_HOME']=home+'/.config'
 p=subprocess.Popen(r['args'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env=child_env,cwd=home)
except Exception:
 if home: shutil.rmtree(home,ignore_errors=True)
 print(json.dumps({'type':'error'}),flush=True)
 sys.exit(1)
sel=selectors.DefaultSelector()
sel.register(sys.stdin.buffer.raw,selectors.EVENT_READ,'control')
sel.register(p.stdout,selectors.EVENT_READ,'stdout')
sel.register(p.stderr,selectors.EVENT_READ,'stderr')
reason=None
stopping=None
killed=False
sent=0
control=b''
deadline=time.monotonic()+timeout
connected=True
def send(value):
 global connected
 try:
  sys.stdout.write(json.dumps(value)+'\\n')
  sys.stdout.flush()
 except (BrokenPipeError,OSError):
  connected=False
  cancel('connection')
def members():
 found=[]
 for name in os.listdir('/proc'):
  if not name.isdigit(): continue
  try:
   with open('/proc/'+name+'/stat') as f: values=f.read().rsplit(')',1)[1].split()
   if p.pid in [int(values[2]),int(values[3])] and values[0] not in ['Z','X']: found.append(int(name))
  except (OSError,ValueError,IndexError): pass
 return found
def kill(value):
 try: os.killpg(p.pid,value)
 except ProcessLookupError: pass
 if os.path.isdir('/proc'):
  for pid in members():
   try: os.kill(pid,value)
   except OSError: pass
def cancel(value):
 global reason,stopping
 if reason is not None: return
 reason=value
 stopping=time.monotonic()
 kill(signal.SIGTERM)
def input_data():
 try: p.stdin.write(r.get('input','').encode('utf-8'));p.stdin.close()
 except (BrokenPipeError,OSError): pass
def group_running():
 if os.path.isdir('/proc'): return bool(members())
 try: os.killpg(p.pid,0);return True
 except ProcessLookupError: return False
 except PermissionError: return True
threading.Thread(target=input_data,daemon=True).start()
while True:
 now=time.monotonic()
 if now>=deadline: cancel('timeout')
 if reason and not killed and now-stopping>=2:
  kill(signal.SIGKILL)
  killed=True
 if reason and now-stopping>=6:
  if home: shutil.rmtree(home,ignore_errors=True)
  send({'type':'error'})
  sys.exit(1)
 for key,_ in sel.select(0.05):
  try: chunk=os.read(key.fileobj.fileno(),16384)
  except OSError: chunk=b''
  if not chunk:
   sel.unregister(key.fileobj)
   if key.data=='control': cancel('connection')
   continue
  if key.data=='control':
   control+=chunk
   if len(control)>1024 or b'\\n' in control: cancel('cancelled')
  else:
   sent+=len(chunk)
   if sent>limit: cancel('limit')
   elif connected: send({'type':key.data,'data':base64.b64encode(chunk).decode('ascii')})
 code=p.poll()
 streams=any(key.data in ['stdout','stderr'] for key in sel.get_map().values())
 if code is not None and not streams and not group_running(): break
p.wait()
if home: shutil.rmtree(home,ignore_errors=True)
if connected: send({'type':'exit','code':code,'reason':reason})
`;

export class WorkspaceCommandError extends Error {
  constructor(
    readonly uncertain: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type WorkspaceCommandLauncher = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export async function runWorkspaceCommand(options: {
  container: string;
  threadId: string;
  args: string[];
  input?: string;
  environment?: Record<string, string>;
  connected?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onData?(chunk: Buffer): void;
  spawn?: WorkspaceCommandLauncher;
  drainTimeoutMs?: number;
}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  if (!/^otto-workspace(?:-[a-zA-Z0-9_-]+)?$/.test(options.container))
    throw new Error('WORKSPACE_CONTAINER must identify an Otto workspace.');
  const id = threadIdentity(options.threadId);
  return runSupervisedCommand({
    ...options,
    launch: () =>
      (options.spawn ?? spawn)(
        'docker',
        [
          'exec',
          '-i',
          '--user',
          options.connected ? 'otto-connected' : 'node',
          ...(options.connected
            ? [
                '--env',
                'HOME=/home/otto-connected',
                '--env',
                'XDG_CONFIG_HOME=/home/otto-connected/.config',
              ]
            : []),
          '--workdir',
          options.connected ? '/home/otto-connected' : `/workspace/${id}`,
          options.container,
          'python3',
          '-u',
          '-c',
          workspaceCommandProgram,
        ],
        { env: serviceEnvironment(), shell: false },
      ),
  });
}

export function runSupervisedCommand(options: {
  args: string[];
  input?: string;
  environment?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onData?(chunk: Buffer): void;
  drainTimeoutMs?: number;
  transportGraceMs?: number;
  launch(): CommandProcess;
}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  options.signal?.throwIfAborted();
  const transportGraceMs = options.transportGraceMs ?? 0;
  if (!Number.isInteger(transportGraceMs) || transportGraceMs < 0 || transportGraceMs > 300_000)
    throw new Error('The workspace transport grace period is invalid.');
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 30_000, 3_600_000));
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? 16 * 1024 * 1024, 16 * 1024 * 1024));
  const request =
    JSON.stringify({
      args: options.args,
      input: options.input ?? '',
      environment: options.environment ?? {},
      timeoutMs,
      maxBytes,
    }) + '\n';
  if (Buffer.byteLength(request) > 1024 * 1024)
    throw new Error('The workspace command is too large.');
  return new Promise((resolve, reject) => {
    let child: CommandProcess;
    try {
      child = options.launch();
    } catch {
      return reject(
        new WorkspaceCommandError(
          true,
          'The workspace is unavailable. Start its container and restart Otto.',
        ),
      );
    }
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let incoming = '';
    let size = 0;
    let settled = false;
    let cancelling = false;
    let response: { code: number; reason: string | null } | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => cancel(), transportGraceMs + timeoutMs + 1000);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(drain);
      options.signal?.removeEventListener('abort', cancel);
    };
    const unavailable = () => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdin.destroy();
      child.kill('SIGKILL');
      reject(
        new WorkspaceCommandError(
          true,
          'The workspace command did not stop safely. Restart Otto before continuing.',
        ),
      );
    };
    function cancel() {
      if (settled || cancelling) return;
      cancelling = true;
      clearTimeout(timer);
      if (!response) child.stdin.write('{"type":"cancel"}\n');
      drain = setTimeout(unavailable, options.drainTimeoutMs ?? 8000);
    }
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', unavailable);
    child.stdin.on('error', unavailable);
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      incoming += chunk;
      for (let end = incoming.indexOf('\n'); end >= 0; end = incoming.indexOf('\n')) {
        const line = incoming.slice(0, end);
        incoming = incoming.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (response) throw new Error();
          if (
            frame.type === 'exit' &&
            Number.isInteger(frame.code) &&
            (frame.reason === null ||
              ['cancelled', 'timeout', 'limit', 'connection'].includes(frame.reason))
          ) {
            response = { code: frame.code, reason: frame.reason };
          } else if (
            ['stdout', 'stderr'].includes(frame.type) &&
            typeof frame.data === 'string' &&
            /^[A-Za-z0-9+/]*={0,2}$/.test(frame.data) &&
            frame.data.length <= 22000
          ) {
            const bytes = Buffer.from(frame.data, 'base64');
            size += bytes.length;
            if (size > maxBytes) cancel();
            else if (options.onData) options.onData(bytes);
            else (frame.type === 'stdout' ? output : errors).push(bytes);
          } else throw new Error();
        } catch {
          return unavailable();
        }
      }
      if (Buffer.byteLength(incoming) > 32768) unavailable();
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 || !response || incoming) return unavailable();
      settled = true;
      cleanup();
      if (options.signal?.aborted || response.reason === 'cancelled')
        return reject(new WorkspaceCommandError(false, 'Task cancelled.'));
      if (cancelling || response.reason)
        return reject(
          new WorkspaceCommandError(false, 'Workspace command exceeded its time or output limit.'),
        );
      resolve({
        stdout: Buffer.concat(output),
        stderr: Buffer.concat(errors),
        exitCode: response.code,
      });
    });
    child.stdin.write(request);
    if (options.signal?.aborted) cancel();
  });
}
