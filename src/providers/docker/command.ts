import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { serviceEnvironment } from '../process.ts';
import type { ConnectedCli } from '../../ports/computer.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import type { CommandProcess } from '../command-process.ts';

const cliInstallProgram = `import bz2,fcntl,gzip,hashlib,json,lzma,os,shutil,subprocess,sys
prefix=os.path.realpath(sys.argv[1])
cli=json.loads(sys.argv[2])
command=cli['command']
source=cli['source']
executable=prefix+'/bin/'+command
lock=os.open(prefix+'.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
fcntl.flock(lock,fcntl.LOCK_EX)
if os.path.isfile(prefix+'/.installed') and os.access(executable,os.X_OK): sys.exit()
def run(*args,**env): subprocess.run(args,check=True,stdin=subprocess.DEVNULL,env={**os.environ,**env})
def head(path,size):
 with open(path,'rb') as file: return file.read(size)
try:
 shutil.rmtree(prefix,ignore_errors=True)
 os.mkdir(prefix,0o700)
 os.mkdir(prefix+'/bin',0o700)
 if 'npm' in source: run('npm','install','--global','--prefix',prefix,'--no-audit','--no-fund','--no-update-notifier',source['npm'])
 elif 'pypi' in source: run('pipx','install',source['pypi'],PIPX_HOME=prefix+'/pipx',PIPX_BIN_DIR=prefix+'/bin',PIPX_MAN_DIR=prefix+'/man')
 else:
  download=prefix+'/download'
  files=prefix+'/files'
  run('curl','--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--output',download,source['url'])
  digest=hashlib.sha256()
  with open(download,'rb') as file:
   for chunk in iter(lambda: file.read(1048576),b''): digest.update(chunk)
  if source.get('sha256',digest.hexdigest())!=digest.hexdigest(): raise ValueError('The download does not match its sha256.')
  for magic,module in [(b'\\x1f\\x8b',gzip),(b'BZh',bz2),(b'\\xfd7zXZ',lzma)]:
   if head(download,6).startswith(magic):
    with module.open(download) as packed, open(download+'.raw','wb') as raw: shutil.copyfileobj(packed,raw)
    os.replace(download+'.raw',download)
  start=head(download,262)
  if start.startswith((b'\\x7fELF',b'#!')):
   os.replace(download,executable)
   os.chmod(executable,0o700)
  else:
   if start.startswith(b'PK\\x03\\x04'): run('unzip','-q',download,'-d',files)
   elif start[257:]==b'ustar':
    os.mkdir(files,0o700)
    run('tar','-xf',download,'-C',files)
   else: raise ValueError('The download is not a program or a tar or zip archive.')
   found=[path for path in (os.path.join(folder,name) for folder,_,names in os.walk(files) for name in names) if os.path.isfile(path) and os.path.realpath(path).startswith(files+'/')]
   named=sorted((path.count('/'),path) for path in found if os.path.basename(path)==command)
   runnable=[path for path in found if os.access(path,os.X_OK)]
   if not named and len(runnable)!=1: raise ValueError(f'The download has no {command} program.')
   chosen=named[0][1] if named else runnable[0]
   os.chmod(os.path.realpath(chosen),0o700)
   os.symlink(os.path.relpath(chosen,prefix+'/bin'),executable)
   os.remove(download)
 if not os.access(executable,os.X_OK): raise ValueError(f'The source has no {command} command.')
 open(prefix+'/.installed','x').close()
except Exception as error:
 shutil.rmtree(prefix,ignore_errors=True)
 sys.exit(str(error) if isinstance(error,ValueError) else f'Could not install {command} from its source.')
`;

const cliInstallTimeoutMs = 600_000;

export const connectedUser = (cli: ConnectedCli) =>
  20_000 + (createHash('sha256').update(cli.id).digest().readUInt32BE() % 40_000);

const workspaceCommandProgram = `import os,sys,json,base64,selectors,subprocess,signal,time,threading,re,tempfile,shutil,glob
import ctypes
try: ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)
except Exception: pass
line=sys.stdin.buffer.raw.readline()
home=None
def sealed(path):
 path=os.path.realpath(path)
 part=path
 while True:
  info=os.lstat(part)
  if info.st_uid not in (0,os.getuid()) or info.st_mode&0o022 and not info.st_mode&0o1000: raise ValueError()
  if part=='/': return path
  part=os.path.dirname(part)
try:
 r=json.loads(line)
 if not isinstance(r['args'],list) or not all(isinstance(v,str) for v in r['args']): raise ValueError()
 env=r.get('environment',{})
 if not isinstance(env,dict) or not all(isinstance(k,str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}(?:TOKEN|KEY|SECRET|PASSWORD|_ID|_SID)',k) and isinstance(v,str) and v for k,v in env.items()): raise ValueError()
 limit=int(r['maxBytes'])
 timeout=float(r['timeoutMs'])/1000
 if limit<1 or not 0<timeout: raise ValueError()
 cli=r.get('cli')
 if cli is None:
  if not r['args'] or env: raise ValueError()
  steps=[(r['args'],os.environ.copy(),timeout)]
 else:
  install=float(r['installTimeoutMs'])/1000
  if not re.fullmatch(r'[0-9a-f-]{36}',cli['id']) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}',cli['command']) or not env or not 0<install: raise ValueError()
  prefix=sealed('.')+'/nod-cli-'+cli['id']
  os.close(os.open(prefix+'.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600))
  home=tempfile.mkdtemp(prefix='nod-cli-')
  system='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  base={'HOME':home,'XDG_CONFIG_HOME':home+'/.config','LANG':'C.UTF-8'}
  steps=[([sys.executable,'-I','-c',${JSON.stringify(cliInstallProgram)},prefix,json.dumps(cli)],{**base,'PATH':system},install),([prefix+'/bin/'+cli['command'],*r['args']],{**base,'PATH':prefix+'/bin:'+system,**env},timeout)]
except Exception:
 if home: shutil.rmtree(home,ignore_errors=True)
 print(json.dumps({'type':'error'}),flush=True)
 sys.exit(1)
sel=selectors.DefaultSelector()
sel.register(sys.stdin.buffer.raw,selectors.EVENT_READ,'control')
reason=None
stopping=None
killed=False
sent=0
control=b''
connected=True
p=None
def send(value):
 global connected
 try:
  sys.stdout.write(json.dumps(value)+'\\n')
  sys.stdout.flush()
 except (BrokenPipeError,OSError):
  connected=False
  cancel('connection')
def output(kind,data):
 if connected: send({'type':kind,'data':base64.b64encode(data).decode('ascii')})
def finish(frame):
 if home: shutil.rmtree(home,ignore_errors=True)
 if connected: send(frame)
 sys.exit(frame['type']!='exit')
def members():
 found=[]
 if not os.path.isdir('/proc'): return found
 for name in os.listdir('/proc'):
  if not name.isdigit(): continue
  try:
   with open('/proc/'+name+'/stat') as f: values=f.read().rsplit(')',1)[1].split()
   if p.pid in [int(values[2]),int(values[3])] and values[0] not in ['Z','X']: found.append(int(name))
  except (OSError,ValueError,IndexError): pass
 return found
def descendants():
 table={}
 if not os.path.isdir('/proc'): return []
 for name in os.listdir('/proc'):
  if not name.isdigit(): continue
  try:
   with open('/proc/'+name+'/stat') as f: values=f.read().rsplit(')',1)[1].split()
  except (OSError,ValueError,IndexError): continue
  if values[0] in ['Z','X']: continue
  table[int(name)]=int(values[1])
 tree={os.getpid(),p.pid}
 grow=True
 while grow:
  grow=False
  for pid,ppid in table.items():
   if pid in tree: continue
   if ppid in tree: tree.add(pid); grow=True
 return sorted(tree-{os.getpid(),p.pid})
def kill(value):
 try: os.killpg(p.pid,value)
 except ProcessLookupError: pass
 if os.path.isdir('/proc'):
  for pid in set(members())|set(descendants()):
   try: os.kill(pid,value)
   except OSError: pass
def cancel(value):
 global reason,stopping
 if reason is not None: return
 reason=value
 stopping=time.monotonic()
 if p: kill(signal.SIGTERM)
def input_data():
 try: p.stdin.write(r.get('input','').encode('utf-8'));p.stdin.close()
 except (BrokenPipeError,OSError): pass
def group_running():
 if os.path.isdir('/proc'): return bool(members())
 try: os.killpg(p.pid,0);return True
 except ProcessLookupError: return False
 except PermissionError: return True
for index,(args,child_env,seconds) in enumerate(steps):
 last=index==len(steps)-1
 try:
  if cli is not None:
   if any(os.lstat(path).st_uid==os.getuid() for path in glob.glob(os.path.dirname(prefix)+'/nod-cli-*') if not path.startswith(prefix)): raise ValueError()
   if last: sealed(args[0])
 except (OSError,ValueError):
  output('stderr',b'The connected CLI install is not sealed. Propose it again.\\n')
  finish({'type':'exit','code':126,'reason':None})
 try: p=subprocess.Popen(args,stdin=subprocess.PIPE if last else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env=child_env,cwd=home)
 except OSError as error:
  output('stderr',(str(error)+'\\n').encode())
  finish({'type':'exit','code':127,'reason':None})
 sel.register(p.stdout,selectors.EVENT_READ,'stdout')
 sel.register(p.stderr,selectors.EVENT_READ,'stderr')
 if last: threading.Thread(target=input_data,daemon=True).start()
 log=b''
 deadline=time.monotonic()+seconds
 while True:
  now=time.monotonic()
  if now>=deadline: cancel('timeout')
  if reason and not killed and now-stopping>=2:
   kill(signal.SIGKILL)
   killed=True
  if reason and now-stopping>=6: finish({'type':'error'})
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
   elif not last: log=(log+chunk)[-16384:]
   else:
    sent+=len(chunk)
    if sent>limit: cancel('limit')
    else: output(key.data,chunk)
  code=p.poll()
  if code is not None:
   try:
    while os.waitpid(-1,os.WNOHANG)[0]: pass
   except (ChildProcessError,OSError): pass
  streams=any(key.data in ['stdout','stderr'] for key in sel.get_map().values())
  if code is not None and not streams:
   if reason:
    if not members() and not descendants(): break
   elif not group_running():
    for pid in descendants():
     try: os.kill(pid,signal.SIGKILL)
     except OSError: pass
    break
 p.wait()
 if reason or code: break
if code and not last and not reason: output('stderr',log[-limit:])
finish({'type':'exit','code':code,'reason':reason})
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
  cli?: ConnectedCli;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onData?(chunk: Buffer): void;
  spawn?: WorkspaceCommandLauncher;
  drainTimeoutMs?: number;
}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  if (!/^nod-workspace(?:-[a-zA-Z0-9_-]+)?$/.test(options.container))
    throw new Error('WORKSPACE_CONTAINER must identify a Nod workspace.');
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
          options.cli ? `${connectedUser(options.cli)}:1002` : 'node',
          '--workdir',
          options.cli ? '/var/tmp' : `/workspace/${id}`,
          options.container,
          '/usr/bin/python3',
          '-I',
          '-u',
          '-c',
          workspaceCommandProgram,
        ],
        { env: serviceEnvironment(), shell: false },
      ),
  });
}

function runSupervisedCommand(options: {
  args: string[];
  input?: string;
  environment?: Record<string, string>;
  cli?: ConnectedCli;
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
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
  const maxBytes = Math.max(1, options.maxBytes ?? 16 * 1024 * 1024);
  const request =
    JSON.stringify({
      args: options.args,
      input: options.input ?? '',
      environment: options.environment ?? {},
      timeoutMs,
      maxBytes,
      ...(options.cli && { cli: options.cli, installTimeoutMs: cliInstallTimeoutMs }),
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
          'The workspace is unavailable. Start its container and restart Nod.',
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
    const timer = setTimeout(
      () => cancel(),
      Math.min(
        transportGraceMs + timeoutMs + (options.cli ? cliInstallTimeoutMs : 0) + 1000,
        2 ** 31 - 1,
      ),
    );
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
          'The workspace command did not stop safely. Restart Nod before continuing.',
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
