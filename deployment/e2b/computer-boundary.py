import base64
import json
import os
import pathlib
import socket
import subprocess
import time
import uuid


class BoundaryFailure(Exception):
    pass


def require(condition, check):
    if not condition:
        raise BoundaryFailure(check)


def user_environment(uid, env=None):
    home = {1000: "/home/node", 1001: "/home/otto-browser", 1002: "/home/otto-connected"}[uid]
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": home, "LANG": "C.UTF-8", **(env or {})}


def as_user(uid, args, timeout=15, env=None):
    def identity():
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
    return subprocess.run(["/usr/bin/setpriv", "--no-new-privs", *args], capture_output=True, timeout=timeout, preexec_fn=identity, env=user_environment(uid, env))


def connected_cli():
    command = "otto-boundary"
    plant = "import pathlib\np=pathlib.Path('/workspace/boundary-bin');p.mkdir(mode=0o755)\nfor name in ['otto-boundary','python3','sh','env','npm']:\n f=p/name;f.write_text('#!/bin/sh\\necho otto-planted-binary\\n');f.chmod(0o755)"
    require(as_user(1000, ["python3", "-c", plant]).returncode == 0, "connected-cli")
    identity = str(uuid.uuid4())
    prefix = pathlib.Path("/home/otto-connected/cli", identity)
    (prefix / "bin").mkdir(parents=True)
    (prefix / "bin" / command).write_text("#!/bin/sh\nenv\n")
    (prefix / ".installed").write_text("")
    for path in [prefix.parent, prefix, prefix / "bin", prefix / "bin" / command, prefix / ".installed"]:
        os.chown(path, 1002, 1002)
        os.chmod(path, 0o700)
    def connected():
        os.setgroups([])
        os.setgid(1002)
        os.setuid(1002)
    request = {"args": ["status"], "environment": {"OTTO_BOUNDARY_TOKEN": "synthetic-boundary"}, "cli": {"id": identity, "command": command, "source": {"npm": command}}, "timeoutMs": 10000, "installTimeoutMs": 10000, "maxBytes": 8192}
    child = subprocess.Popen(["/usr/bin/setpriv", "--no-new-privs", "/usr/bin/python3", "-I", "-u", "/opt/otto/workspace-command.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd="/home/otto-connected", env={"PATH": "/workspace/boundary-bin:/opt/otto-artifacts/bin:/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin", "NPM_CONFIG_PREFIX": "/home/node/.local", "PYTHONPATH": "/workspace/boundary-bin", "LANG": "C.UTF-8"}, preexec_fn=connected)
    child.stdin.write((json.dumps(request) + "\n").encode())
    child.stdin.flush()
    output = child.stdout.read()
    child.stdin.close()
    errors = child.stderr.read()
    code = child.wait(timeout=30)
    require(b"otto-planted-binary" not in output + errors, "connected-cli-planted")
    frames = [json.loads(line) for line in output.splitlines()]
    printed = b"".join(base64.b64decode(frame["data"]) for frame in frames if frame["type"] in ["stdout", "stderr"]).decode()
    require("otto-planted-binary" not in printed, "connected-cli-planted")
    values = dict(line.split("=", 1) for line in printed.splitlines() if "=" in line)
    require(code == 0 and not errors and frames[-1] == {"type": "exit", "code": 0, "reason": None}, "connected-cli")
    require(values.get("OTTO_BOUNDARY_TOKEN") == "synthetic-boundary" and values.get("PATH") == f"{prefix}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" and set(values) <= {"OTTO_BOUNDARY_TOKEN", "PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "PWD", "OLDPWD", "SHLVL", "_"}, "connected-cli")


def main():
    children = []
    try:
        pathlib.Path("/data/boundary-profile").mkdir(mode=0o700)
        os.chown("/data/boundary-profile", 1001, 1001)
        pathlib.Path("/data/boundary-private").write_text("synthetic-private")
        os.chown("/data/boundary-private", 1001, 1001)
        os.chmod("/data/boundary-private", 0o600)
        def browser():
            os.setgroups([])
            os.setgid(1001)
            os.setuid(1001)
        chromium = subprocess.Popen(["/usr/bin/chromium", "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=19222", "--remote-debugging-address=127.0.0.1", "--user-data-dir=/data/boundary-profile", "about:blank"], preexec_fn=browser, env=user_environment(1001), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        children.append(chromium)
        server = subprocess.Popen(["python3", "-c", "import socket,threading,time\ndef serve(family,address,port):\n s=socket.socket(family);s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n if family==socket.AF_INET6:s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)\n s.bind((address,port));s.listen()\n while True:\n  c,_=s.accept();c.sendall(b'synthetic');c.close()\nfor family,address,port in [(socket.AF_INET,'0.0.0.0',19333),(socket.AF_INET6,'::',19333),(socket.AF_INET,'0.0.0.0',49983)]:threading.Thread(target=serve,args=(family,address,port),daemon=True).start()\ntime.sleep(120)"], preexec_fn=browser, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        children.append(server)
        authority = "/data/boundary.Xauthority"
        xauth = as_user(1001, ["xauth", "-f", authority, "add", ":107", ".", "0123456789abcdef0123456789abcdef"])
        require(xauth.returncode == 0, "xauthority-creation")
        os.chmod(authority, 0o600)
        display = subprocess.Popen(["Xvfb", ":107", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-auth", authority], preexec_fn=browser, env=user_environment(1001), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        children.append(display)
        until = time.monotonic() + 20
        while True:
            cdp = as_user(1001, ["curl", "--fail", "--silent", "--max-time", "2", "http://127.0.0.1:19222/json/version"])
            desktop = as_user(1001, ["xdotool", "getdisplaygeometry"], env={"DISPLAY": ":107", "XAUTHORITY": authority})
            if cdp.returncode == 0 and "Browser" in json.loads(cdp.stdout) and desktop.returncode == 0:
                break
            require(chromium.poll() is None, "chromium-exited")
            require(display.poll() is None, "xvfb-exited")
            require(time.monotonic() < until, "browser-readiness")
            time.sleep(0.1)
        addresses = json.loads(subprocess.check_output(["ip", "-json", "address", "show"]))
        own = next(item["local"] for interface in addresses if interface["ifname"] != "lo" for item in interface["addr_info"] if item["family"] == "inet")
        targets = [("127.0.0.1", 19222), ("::1", 19333), (own, 19333), ("169.254.169.254", 19333), ("fd00:ec2::254", 19333), ("127.0.0.1", 49983)]
        for index, (host, port) in enumerate(targets):
            probe = f"import socket; s=socket.create_connection(({host!r},{port}),2); assert s.recv(100)"
            if port == 19222:
                probe = f"import socket; s=socket.create_connection(({host!r},{port}),2); s.close()"
            require(as_user(1001, ["python3", "-c", probe]).returncode == 0, f"browser-network-{index}")
            require(as_user(1000, ["python3", "-c", probe]).returncode != 0, f"workspace-network-{index}")
            require(as_user(1002, ["python3", "-c", probe]).returncode != 0, f"connected-network-{index}")
        checks = [
            "from pathlib import Path; Path('/data/boundary-private').read_bytes()",
            "from pathlib import Path; Path('/data/boundary-profile').iterdir().__next__()",
            "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/data/control.sock')",
            "import os; os.open('/opt/otto/workspace-command.py',os.O_WRONLY)",
            "import os; os.open('/app/src/providers/container-browser/worker.ts',os.O_WRONLY)",
            "import os; os.setuid(0)",
            f"import os; os.kill({chromium.pid},0)",
            f"from pathlib import Path; Path('/proc/{chromium.pid}/environ').read_bytes()",
        ]
        for index, script in enumerate(checks):
            require(as_user(1000, ["python3", "-c", script]).returncode != 0, f"workspace-private-{index}")
            require(as_user(1002, ["python3", "-c", script]).returncode != 0, f"connected-private-{index}")
        require(as_user(1002, ["python3", "-c", "from pathlib import Path; Path('/home/otto-connected/boundary-token').write_text('synthetic')"]).returncode == 0, "connected-home-write")
        require(as_user(1000, ["python3", "-c", "from pathlib import Path; Path('/home/otto-connected/boundary-token').read_text()"]).returncode != 0, "workspace-connected-home-denied")
        connected_cli()
        require(as_user(1000, ["nft", "list", "ruleset"]).returncode != 0, "workspace-firewall")
        require(as_user(1000, ["xdotool", "getdisplaygeometry"], env={"DISPLAY": ":107", "XAUTHORITY": authority}).returncode != 0, "workspace-x11")
        safe = as_user(1000, ["python3", "-c", "from pathlib import Path; import socket; s=Path('/proc/self/status').read_text(); assert 'NoNewPrivs:\\t1' in s; assert all(int(line.split()[1],16)==0 for line in s.splitlines() if line.startswith(('CapEff:','CapPrm:','CapAmb:'))); p=Path('/workspace/boundary.txt'); p.write_text('synthetic'); assert p.read_text()=='synthetic'; assert socket.getaddrinfo('example.com',443)"])
        require(safe.returncode == 0, "workspace-files-dns-privileges")
        require(as_user(1000, ["curl", "--fail", "--silent", "--output", "/dev/null", "--max-time", "10", "https://example.com"]).returncode == 0, "workspace-https")
        require(subprocess.run(["python3", "/opt/otto/computer-guard.py", "check"], capture_output=True, timeout=20).returncode == 0, "unchanged-firewall-readiness")
        subprocess.run(["nft", "delete", "table", "inet", "otto"], check=True, capture_output=True)
        require(subprocess.run(["python3", "/opt/otto/computer-guard.py", "check"], capture_output=True, timeout=20).returncode != 0, "changed-firewall-readiness")
        print(json.dumps({"browserCdpAndX11": True, "workspaceNetworkDenied": len(targets), "connectedNetworkDenied": len(targets), "workspaceFileAndProcessDenied": len(checks), "connectedFileAndProcessDenied": len(checks), "connectedCliSealed": True, "workspacePrivilegeDenied": True, "workspaceInternetDnsFiles": True, "changedFirewallRejected": True}))
    finally:
        for child in children:
            child.terminate()
        for child in children:
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)


if __name__ == "__main__":
    try:
        main()
    except BoundaryFailure as error:
        print(json.dumps({"passed": False, "check": str(error)}))
        raise SystemExit(1)
    except Exception:
        print('{"passed":false,"check":"fixture-error"}')
        raise SystemExit(1)
