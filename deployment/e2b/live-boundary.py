import base64
import ctypes
import ipaddress
import json
import os
import pathlib
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid


PROBE_PATH = "/run/otto/live-boundary.py"
OUTPUT_LIMIT = 16384
WORK_SECONDS = 100
CLEANUP_SECONDS = 20
RESTRICTED_ROLES = (("workspace", 1000), ("connected", 1002))
CHECKS = frozenset([
    "invocation", "probe-file", "root-net-admin", "initial-readiness",
    "final-readiness", "interface-addresses", "listener-output",
    "browser-network", "envd-root", "envd-browser",
    "display-busy", "xauthority", "browser-readiness",
    "browser-cdp", "browser-private", "browser-process",
    "operation-timeout", "operation-output", "probe-timeout", "probe-cancelled", "cleanup",
    "probe-error", "connected-process", "workspace-connected-private",
    "connected-cli", "connected-cli-planted",
] + [f"{role}-{check}" for role, _ in RESTRICTED_ROLES for check in [
    "network", "cdp", "private", "firewall", "x11", "privileges", "files-dns", "https",
]] + [f"envd-{role}" for role, _ in RESTRICTED_ROLES])


class BoundaryFailure(Exception):
    pass


def require(value, label):
    if not value:
        raise BoundaryFailure(label)


def environment(uid, extra=None):
    homes = {0: "/nonexistent", 1000: "/home/node", 1001: "/home/otto-browser", 1002: "/home/otto-connected"}
    return {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin", "HOME": homes[uid], "LANG": "C.UTF-8", **(extra or {})}


def user_command(uid, args):
    return ["/usr/bin/setpriv", "--no-new-privs", "--reuid", str(uid), "--regid", str(uid), "--clear-groups", *args]


class Processes:
    def __init__(self):
        self.children = []
        self.display_paths = []

    def start(self, uid, args, extra=None, output=False, data=None):
        child = subprocess.Popen(user_command(uid, args), cwd="/", env=environment(uid, extra), stdin=subprocess.PIPE if data else subprocess.DEVNULL, stdout=subprocess.PIPE if output else subprocess.DEVNULL, stderr=subprocess.PIPE if output else subprocess.DEVNULL, start_new_session=True)
        self.children.append(child)
        if data:
            child.stdin.write(data)
            child.stdin.flush()
        return child

    def running(self, child):
        if child.returncode is not None:
            return False
        try:
            return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None
        except ChildProcessError:
            return False

    def run(self, uid, args, timeout=5, extra=None, data=None):
        child = self.start(uid, args, extra, True, data)
        buffers = [bytearray(), bytearray()]
        end = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, 0)
            selector.register(child.stderr, selectors.EVENT_READ, 1)
            while selector.get_map():
                require(time.monotonic() < end, "operation-timeout")
                for key, _ in selector.select(min(0.1, max(0, end - time.monotonic()))):
                    data = os.read(key.fileobj.fileno(), 4096)
                    if not data:
                        selector.unregister(key.fileobj)
                    else:
                        buffers[key.data].extend(data)
                        require(sum(map(len, buffers)) <= OUTPUT_LIMIT, "operation-output")
        require(time.monotonic() < end, "operation-timeout")
        code = child.wait(timeout=max(0.001, end - time.monotonic()))
        for stream in [child.stdin, child.stdout, child.stderr]:
            if stream:
                stream.close()
        self.children.remove(child)
        return code, bytes(buffers[0]), bytes(buffers[1])

    def python(self, uid, source, label, timeout=5, extra=None):
        result = self.run(uid, ["/usr/bin/python3", "-c", source], timeout, extra)
        require(result == (0, b"", b""), label)

    def cleanup(self):
        children = list(self.children)
        complete = True
        for child in children:
            if child.returncode is not None:
                continue
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except OSError:
                complete = False
        end = time.monotonic() + 3
        while time.monotonic() < end and any(self.running(child) for child in children):
            time.sleep(0.05)
        for child in children:
            if child.returncode is not None:
                continue
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                complete = False
        end = time.monotonic() + 10
        while True:
            path = pathlib.Path(f"/proc/self/task/{os.getpid()}/children")
            with path.open("rb") as stream:
                pending = stream.read(8193)
            require(len(pending) <= 8192, "cleanup")
            pids = [int(value) for value in pending.split()]
            for pid in pids:
                try:
                    if os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                        os.kill(pid, signal.SIGKILL)
                except (ChildProcessError, ProcessLookupError):
                    pass
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if pid == 0:
                        break
                except ChildProcessError:
                    break
            if not pids:
                break
            if time.monotonic() >= end:
                complete = False
                break
            time.sleep(0.05)
        for child in children:
            child.returncode = 0
            for stream in [child.stdout, child.stderr]:
                if stream:
                    stream.close()
        self.children.clear()
        return complete and not any(os.path.lexists(path) for path in self.display_paths)


def addresses(raw):
    value = json.loads(raw)
    require(isinstance(value, list) and len(value) <= 32, "interface-addresses")
    found = set()
    counts = {4: 0, 6: 0}
    result = [(socket.AF_INET, "127.0.0.1", 0), (socket.AF_INET6, "::1", 0)]
    for interface in value:
        index = interface["ifindex"]
        require(type(index) is int and index > 0, "interface-addresses")
        for item in interface.get("addr_info", []):
            address = ipaddress.ip_address(item["local"])
            if address.is_loopback:
                continue
            require(not address.is_unspecified and not address.is_multicast, "interface-addresses")
            scope = index if address.version == 6 and address.is_link_local else 0
            entry = (socket.AF_INET if address.version == 4 else socket.AF_INET6, str(address), scope)
            if entry not in found:
                found.add(entry)
                result.append(entry)
                counts[address.version] += 1
    require(len(found) <= 16, "interface-addresses")
    return result, counts


LISTENER = """import json,os,selectors,socket,sys,time
assert (os.getuid(),os.getgid(),os.getgroups())==(1001,1001,[])
targets=json.loads(sys.argv[1]); sockets=[]
try:
 for family,host,scope in targets:
  s=socket.socket(family,socket.SOCK_STREAM); sockets.append(s)
  if family==socket.AF_INET6:s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
  s.bind((host,0,0,scope) if family==socket.AF_INET6 else (host,0))
  assert s.getsockname()[1]!=49983
  s.listen(8); s.setblocking(False)
 print(json.dumps([s.getsockname()[1] for s in sockets]),flush=True)
 with selectors.DefaultSelector() as selector:
  for s in sockets:selector.register(s,selectors.EVENT_READ)
  end=time.monotonic()+110
  while time.monotonic()<end:
   for key,_ in selector.select(.2):
    c,_=key.fileobj.accept()
    with c:c.settimeout(1);c.sendall(b'otto-live-boundary')
finally:
 for s in sockets:s.close()
"""


def read_line(child, label):
    output = bytearray()
    end = time.monotonic() + 5
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        while b"\n" not in output:
            require(time.monotonic() < end, label)
            for key, _ in selector.select(0.1):
                data = os.read(key.fileobj.fileno(), 4096)
                require(data, label)
                output.extend(data)
                require(len(output) <= 4096, label)
    require(output.endswith(b"\n") and output.count(b"\n") == 1, label)
    return bytes(output)


def read_listener(child, count):
    ports = json.loads(read_line(child, "listener-output"))
    require(isinstance(ports, list) and len(ports) == count, "listener-output")
    require(all(type(port) is int and 1024 <= port <= 65535 and port != 49983 for port in ports), "listener-output")
    return ports


def tcp_source(target, port, denied=False, marker=False):
    family, host, scope = target
    destination = (host, port, 0, scope) if family == socket.AF_INET6 else (host, port)
    start = f"import errno,socket\ns=socket.socket({family},socket.SOCK_STREAM);s.settimeout(2)\n"
    if denied:
        return start + f"try:\n s.connect({destination!r})\nexcept OSError as error:\n assert error.errno in (errno.EACCES,errno.EPERM,errno.ECONNREFUSED,errno.EHOSTUNREACH)\nelse:\n raise AssertionError()\nfinally:\n s.close()"
    read = "\n assert s.recv(64)==b'otto-live-boundary'" if marker else ""
    return start + f"with s:\n s.connect({destination!r})" + read


def denial_source(operation):
    return "import errno,os,socket\ntry:\n " + operation + "\nexcept OSError as error:\n assert error.errno in (errno.EACCES,errno.EPERM)\nelse:\n raise AssertionError()"


def private_file(path, uid, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        os.fchown(output.fileno(), uid, uid)
        output.write(content)


def guard(processes, label):
    require(processes.run(0, ["/usr/bin/python3", "/opt/otto/computer-guard.py", "check"], 20) == (0, b'{"ready":true}\n', b""), label)


def check_browser(processes, directory):
    display_paths = ["/tmp/.X107-lock", "/tmp/.X11-unix/X107"]
    require(not any(os.path.lexists(path) for path in display_paths), "display-busy")
    profile = directory / "profile"
    profile.mkdir(mode=0o700)
    os.chown(profile, 1001, 1001)
    private_file(directory / "private", 1001, b"otto-live-boundary")
    authority = str(directory / "Xauthority")
    private_file(authority, 1001, b"")
    cookie = uuid.uuid4().hex
    code, _, _ = processes.run(1001, ["/usr/bin/xauth", "-f", authority, "add", ":107", ".", cookie])
    require(code == 0, "xauthority")
    chromium = processes.start(1001, ["/usr/bin/chromium", "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", f"--user-data-dir={profile}", "about:blank"])
    processes.display_paths.extend(display_paths)
    display = processes.start(1001, ["/usr/bin/Xvfb", ":107", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-auth", authority])
    desktop_environment = {"DISPLAY": ":107", "XAUTHORITY": authority}
    end = time.monotonic() + 20
    port = None
    while time.monotonic() < end:
        require(processes.running(chromium) and processes.running(display), "browser-readiness")
        path = profile / "DevToolsActivePort"
        if path.exists():
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 1001 and info.st_size <= 1024, "browser-readiness")
            with path.open("rb") as stream:
                value = stream.read(1025).splitlines()
            require(value and value[0].isdigit(), "browser-readiness")
            port = int(value[0])
            require(1024 <= port <= 65535 and port != 49983, "browser-readiness")
            code, output, _ = processes.run(1001, ["/usr/bin/xdotool", "getdisplaygeometry"], 3, desktop_environment)
            if code == 0 and output == b"1280 800\n":
                break
        time.sleep(0.1)
    else:
        raise BoundaryFailure("browser-readiness")
    cdp = f"import json,urllib.request\nr=urllib.request.urlopen('http://127.0.0.1:{port}/json/version',timeout=2)\nv=r.read(4097);r.close()\nassert len(v)<=4096 and isinstance(json.loads(v).get('Browser'),str)"
    processes.python(1001, cdp, "browser-cdp")
    return profile, desktop_environment, display, cdp, port


def check_x11(processes, desktop_environment, display, role, uid):
    command = ["/usr/bin/xdotool", "getdisplaygeometry"]
    require(processes.running(display), "browser-readiness")
    require(processes.run(1001, command, 3, desktop_environment) == (0, b"1280 800\n", b""), "browser-readiness")
    require(processes.running(display), "browser-readiness")
    code, _, _ = processes.run(uid, command, 3, desktop_environment)
    require(code != 0, f"{role}-x11")
    require(processes.running(display), "browser-readiness")
    require(processes.run(1001, command, 3, desktop_environment) == (0, b"1280 800\n", b""), "browser-readiness")
    require(processes.running(display), "browser-readiness")


def check_restricted_roles(processes, targets, ports, browser, denials, role_directories):
    _, desktop_environment, display, cdp, cdp_port = browser
    receipts = {}
    envd = (socket.AF_INET, "127.0.0.1", 0)
    for role, uid in RESTRICTED_ROLES:
        for target, port in zip(targets, ports):
            processes.python(1001, tcp_source(target, port, marker=True), "browser-network")
            processes.python(uid, tcp_source(target, port, denied=True), f"{role}-network")
            processes.python(1001, tcp_source(target, port, marker=True), "browser-network")
        processes.python(0, tcp_source(envd, 49983), "envd-root")
        processes.python(1001, tcp_source(envd, 49983), "envd-browser")
        processes.python(uid, tcp_source(envd, 49983, denied=True), f"envd-{role}")
        processes.python(0, tcp_source(envd, 49983), "envd-root")
        processes.python(1001, tcp_source(envd, 49983), "envd-browser")
        processes.python(1001, cdp, "browser-cdp")
        processes.python(uid, tcp_source(envd, cdp_port, denied=True), f"{role}-cdp")
        processes.python(1001, cdp, "browser-cdp")
        for operation in denials:
            processes.python(uid, denial_source(operation), f"{role}-private")
        code, _, _ = processes.run(uid, ["/usr/sbin/nft", "list", "table", "inet", "otto"])
        require(code != 0, f"{role}-firewall")
        check_x11(processes, desktop_environment, display, role, uid)
        processes.python(uid, f"import os,pathlib\nassert (os.getuid(),os.getgid(),os.getgroups())==({uid},{uid},[])\nassert os.environ['HOME']=={environment(uid)['HOME']!r}\ns=pathlib.Path('/proc/self/status').read_text();v=dict(line.split(':',1) for line in s.splitlines())\nassert v['NoNewPrivs'].strip()=='1'\nassert all(int(v[key],16)==0 for key in ['CapEff','CapPrm','CapAmb','CapInh'])", f"{role}-privileges")
        processes.python(uid, f"import pathlib,socket\np=pathlib.Path({str(role_directories[role] / 'sentinel')!r});p.write_text('otto-live-boundary');assert p.read_text()=='otto-live-boundary'\nassert socket.getaddrinfo('example.com',443,type=socket.SOCK_STREAM)", f"{role}-files-dns", 8)
        code, output, errors = processes.run(uid, ["/usr/bin/curl", "--fail", "--silent", "--output", "/dev/null", "--proto", "=https", "--connect-timeout", "3", "--max-time", "8", "https://example.com"], 10)
        require(code == 0 and not output and not errors, f"{role}-https")
        receipts[role] = {"uid": uid, "networkDenied": len(targets) + 2, "privateDenied": len(denials), "firewallDenied": True, "x11Denied": True, "privilegeDenied": True, "internetDnsFiles": True}
    return receipts


def check_connected_private(processes, directory):
    private_file(directory / "private", 1002, b"otto-live-boundary")
    extra = {"OTTO_BOUNDARY_SENTINEL": "synthetic"}
    child = processes.start(1002, ["/usr/bin/python3", "-c", f"import os,time\nos.chdir({str(directory)!r})\nprint('otto-live-boundary',flush=True)\ntime.sleep(110)"], extra, True)
    require(read_line(child, "connected-process") == b"otto-live-boundary\n", "connected-process")
    positive = f"import os\nassert (os.getuid(),os.getgid(),os.getgroups())==(1002,1002,[])\nassert os.listdir('/home/otto-connected')\nassert open({str(directory / 'private')!r},'rb').read(64)==b'otto-live-boundary'\nos.kill({child.pid},0)\nv=open('/proc/{child.pid}/environ','rb').read(4097)\nassert len(v)<=4096\nassert dict(item.decode().split('=',1) for item in v.split(b'\\x00') if item)=={environment(1002, extra)!r}\nassert os.readlink('/proc/{child.pid}/cwd')=={str(directory)!r}"
    require(processes.running(child), "connected-process")
    processes.python(1002, positive, "connected-process")
    denials = [
        "os.open('/home/otto-connected',os.O_RDONLY|os.O_DIRECTORY)",
        f"os.open({str(directory / 'private')!r},os.O_RDONLY)",
        f"os.kill({child.pid},0)",
        f"os.open('/proc/{child.pid}/environ',os.O_RDONLY)",
        f"os.readlink('/proc/{child.pid}/cwd')",
    ]
    for operation in denials:
        processes.python(1000, denial_source(operation), "workspace-connected-private")
    require(processes.running(child), "connected-process")
    processes.python(1002, positive, "connected-process")
    return len(denials)


def check_connected_cli(processes, workspace_directory, connected_directory):
    command = "otto-live-boundary"
    planted = workspace_directory / "bin"
    os.chmod(workspace_directory, 0o755)
    processes.python(1000, f"import pathlib\np=pathlib.Path({str(planted)!r});p.mkdir();p.chmod(0o755)\nfor name in [{command!r},'python3','sh','env','npm']:\n f=p/name;f.write_text('#!/bin/sh\\necho otto-planted-binary\\n');f.chmod(0o755)", "connected-cli")
    identity = str(uuid.uuid4())
    prefix = connected_directory / ("otto-cli-" + identity)
    (prefix / "bin").mkdir(parents=True)
    (prefix / "bin" / command).write_text("#!/bin/sh\nenv\n")
    (prefix / ".installed").write_text("")
    for path in [prefix, prefix / "bin", prefix / "bin" / command, prefix / ".installed"]:
        os.chown(path, 1002, 1002)
        os.chmod(path, 0o700)
    request = {"args": ["status"], "environment": {"OTTO_BOUNDARY_TOKEN": "synthetic-live-boundary"}, "cli": {"id": identity, "command": command, "source": {"npm": command}}, "timeoutMs": 10000, "installTimeoutMs": 10000, "maxBytes": 8192}
    code, output, errors = processes.run(1002, ["/bin/sh", "-c", f"cd {connected_directory} && exec /usr/bin/python3 -I -u /opt/otto/workspace-command.py"], 20, {"PATH": f"{planted}:/usr/local/bin:/usr/bin:/bin", "NPM_CONFIG_PREFIX": str(workspace_directory), "PYTHONPATH": str(planted)}, (json.dumps(request) + "\n").encode())
    require(b"otto-planted-binary" not in output + errors, "connected-cli-planted")
    frames = [json.loads(line) for line in output.splitlines()]
    printed = b"".join(base64.b64decode(frame["data"]) for frame in frames if frame["type"] in ["stdout", "stderr"]).decode()
    require(b"otto-planted-binary" not in printed.encode(), "connected-cli-planted")
    values = dict(line.split("=", 1) for line in printed.splitlines() if "=" in line)
    require(code == 0 and not errors and frames[-1] == {"type": "exit", "code": 0, "reason": None}, "connected-cli")
    require(values.get("OTTO_BOUNDARY_TOKEN") == "synthetic-live-boundary" and values.get("PATH") == f"{prefix}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" and set(values) <= {"OTTO_BOUNDARY_TOKEN", "PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "PWD", "OLDPWD", "SHLVL", "_"}, "connected-cli")
    return True


def probe(processes, directories):
    require(sys.argv == [PROBE_PATH, "--disposable"] and os.geteuid() == 0, "invocation")
    info = os.lstat(PROBE_PATH)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, "probe-file")
    status = pathlib.Path("/proc/self/status").read_text()
    capabilities = next(int(line.split()[1], 16) for line in status.splitlines() if line.startswith("CapEff:"))
    require(capabilities & (1 << 12), "root-net-admin")
    require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, "cleanup")
    guard(processes, "initial-readiness")
    identity = uuid.uuid4().hex
    browser_directory = pathlib.Path("/data") / ("live-boundary-" + identity)
    workspace_directory = pathlib.Path("/workspace") / ("live-boundary-" + identity)
    connected_directory = pathlib.Path("/home/otto-connected") / ("live-boundary-" + identity)
    for path, uid in [(browser_directory, 1001), (workspace_directory, 1000), (connected_directory, 1002)]:
        path.mkdir(mode=0o700)
        directories.append(path)
        os.chown(path, uid, uid)
    code, output, errors = processes.run(0, ["/usr/sbin/ip", "-json", "address", "show"])
    require(code == 0 and not errors, "interface-addresses")
    targets, counts = addresses(output)
    listener = processes.start(1001, ["/usr/bin/python3", "-c", LISTENER, json.dumps(targets)], {"OTTO_BOUNDARY_SENTINEL": "synthetic"}, True)
    ports = read_listener(listener, len(targets))
    browser = check_browser(processes, browser_directory)
    profile, desktop_environment, _, _, _ = browser
    processes.python(1001, f"import os,socket\nassert open({str(browser_directory / 'private')!r},'rb').read(64)==b'otto-live-boundary'\nassert os.listdir({str(profile)!r})\ns=socket.socket(socket.AF_UNIX);s.settimeout(2);s.connect('/data/control.sock');s.close()", "browser-private")
    require(processes.running(listener), "browser-process")
    browser_environment = environment(1001, {"OTTO_BOUNDARY_SENTINEL": "synthetic"})
    processes.python(1001, f"import os\nassert (os.getuid(),os.getgid(),os.getgroups())==(1001,1001,[])\nos.kill({listener.pid},0)\nv=open('/proc/{listener.pid}/environ','rb').read(4097)\nassert len(v)<=4096\nassert dict(item.decode().split('=',1) for item in v.split(b'\\x00') if item)=={browser_environment!r}", "browser-process")
    denials = [
        f"os.open({str(browser_directory / 'private')!r},os.O_RDONLY)",
        f"os.open({str(profile)!r},os.O_RDONLY|os.O_DIRECTORY)",
        f"os.open({desktop_environment['XAUTHORITY']!r},os.O_RDONLY)",
        "socket.socket(socket.AF_UNIX).connect('/data/control.sock')",
        "os.open('/home/otto-browser',os.O_RDONLY|os.O_DIRECTORY)",
        "os.open('/root',os.O_RDONLY|os.O_DIRECTORY)",
        f"os.open({PROBE_PATH!r},os.O_RDONLY)",
        "os.open('/opt/otto/computer-guard.py',os.O_WRONLY|os.O_NOFOLLOW)",
        "os.open('/opt/otto/workspace-command.py',os.O_WRONLY|os.O_NOFOLLOW)",
        "os.open('/app/src/providers/container-browser/worker.ts',os.O_WRONLY|os.O_NOFOLLOW)",
        "os.setuid(0)",
        f"os.kill({listener.pid},0)",
        f"os.open('/proc/{listener.pid}/environ',os.O_RDONLY)",
    ]
    roles = check_restricted_roles(processes, targets, ports, browser, denials, {"workspace": workspace_directory, "connected": connected_directory})
    require(processes.running(listener), "browser-process")
    connected_private = check_connected_private(processes, connected_directory)
    connected_cli = check_connected_cli(processes, workspace_directory, connected_directory)
    guard(processes, "final-readiness")
    return {"passed": True, "version": 2, "readinessChecks": 2, "rootNetAdmin": True, "browserCdpAndX11": True, "loopbackIpv4": 1, "loopbackIpv6": 1, "ownInterfaceIpv4": counts[4], "ownInterfaceIpv6": counts[6], "roles": roles, "envdTcpControls": 2, "workspaceConnectedPrivateDenied": connected_private, "connectedCliSealed": connected_cli, "firewallUnchanged": True, "cleanupComplete": True}


def expired(_signum, _frame):
    raise BoundaryFailure("probe-timeout")


def cancelled(_signum, _frame):
    raise BoundaryFailure("probe-cancelled")


def main():
    processes = Processes()
    directories = []
    result = None
    cleanup = False
    previous = signal.signal(signal.SIGALRM, expired)
    previous_term = signal.signal(signal.SIGTERM, cancelled)
    previous_int = signal.signal(signal.SIGINT, cancelled)
    previous_child = signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    try:
        signal.alarm(WORK_SECONDS)
        result = probe(processes, directories)
    except BoundaryFailure as error:
        label = str(error)
        result = {"passed": False, "version": 2, "check": label if label in CHECKS else "probe-error", "cleanupComplete": False}
    except Exception:
        result = {"passed": False, "version": 2, "check": "probe-error", "cleanupComplete": False}
    finally:
        signal.alarm(CLEANUP_SECONDS)
        try:
            cleanup = processes.cleanup()
            if cleanup:
                for path in directories:
                    shutil.rmtree(path)
        except Exception:
            cleanup = False
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
            signal.signal(signal.SIGTERM, previous_term)
            signal.signal(signal.SIGINT, previous_int)
            signal.signal(signal.SIGCHLD, previous_child)
    if not cleanup and result["passed"]:
        result = {"passed": False, "version": 2, "check": "cleanup", "cleanupComplete": False}
    result["cleanupComplete"] = cleanup
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
