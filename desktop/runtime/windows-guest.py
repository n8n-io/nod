import hashlib
import json
import os
import re
import subprocess
import sys
import time

docker = '/usr/local/bin/docker'

if sys.argv[1] == 'docker':
    args = sys.argv[2:]
    if args and args[0] == 'exec' and '--workdir' in args:
        index = args.index('--workdir')
        directory = args[index + 1]
        container = args[index + 2]
        if re.fullmatch(r'/workspace/[a-zA-Z0-9_-]{1,100}', directory) and re.fullmatch(r'nod-workspace-[a-f0-9]{12}', container):
            subprocess.run([docker, 'exec', '--user', 'node', '--workdir', '/workspace', container, 'mkdir', '-p', '--', directory], check=True, stdout=subprocess.DEVNULL)
    os.execv(docker, [docker, *args])

if sys.argv[1] not in ['start', 'image']:
    sys.exit(64)
config = json.loads(sys.stdin.buffer.read(8193))
if not re.fullmatch(r'[a-f0-9]{12}', config['identity']):
    sys.exit(64)
identity = '/var/lib/nod/identity'
os.makedirs('/var/lib/nod', mode=0o700, exist_ok=True)
if os.path.exists(identity):
    if open(identity).read() != config['identity']:
        sys.exit('The Nod computer identity changed.')
else:
    with open(identity, 'x') as file:
        file.write(config['identity'])
if subprocess.run([docker, 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
    with open('/var/log/nod-docker.log', 'ab') as log:
        subprocess.Popen(['/usr/local/bin/dockerd', '--config-file=/etc/docker/daemon.json', '--host=unix:///var/run/docker.sock'], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
for attempt in range(120):
    if subprocess.run([docker, 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        break
    time.sleep(0.5)
else:
    with open('/var/log/nod-docker.log', 'rb') as log:
        log.seek(max(0, log.seek(0, os.SEEK_END) - 4096))
        lines = [line for line in log.read().decode(errors='replace').split('\n') if line.strip()]
    sys.exit('Docker did not start: ' + (lines[-1][-200:] if lines else 'no log'))
if sys.argv[1] == 'start':
    sys.exit(0)
name = config.get('name')
if name not in ['postgres', 'workspace', 'browser']:
    sys.exit(64)
manifest = json.load(open('/opt/nod-assets/manifest.json'))
images = [image for image in manifest['images'] if image['name'] == name]
if len(images) != 1:
    sys.exit(64)
image = images[0]
if image['file'] != 'images/' + name + '.tar.zst' or not re.fullmatch(r'sha256:[a-f0-9]{64}', image['id']) or not re.fullmatch(r'[a-f0-9]{64}', image['sha256']):
    sys.exit(64)
result = subprocess.run([docker, 'image', 'inspect', '--format', '{{.Id}}', image['reference']], capture_output=True, text=True)
if result.returncode or result.stdout.strip() != image['id']:
    path = '/opt/nod-assets/' + image['file']
    with open(path, 'rb') as file:
        if hashlib.file_digest(file, 'sha256').hexdigest() != image['sha256']:
            sys.exit(f'The {name} image failed its integrity check.')
    loaded = subprocess.run([docker, 'load', '--input', path], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if loaded.returncode:
        sys.exit(f'Docker could not load the {name} image: {loaded.stderr.strip()[-200:]}')
result = subprocess.run([docker, 'image', 'inspect', '--format', '{{.Id}}', image['reference']], capture_output=True, text=True)
if result.returncode or result.stdout.strip() != image['id']:
    sys.exit(f'The {name} image does not match the Nod computer manifest.')
