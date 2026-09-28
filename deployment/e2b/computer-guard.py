import hashlib
import ipaddress
import json
import os
import pathlib
import pwd
import stat
import subprocess
import sys


def command(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=15, check=True)
    if len(result.stdout) > 1024 * 1024:
        raise ValueError()
    return result.stdout


def trusted(path, uid=0, private=False):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_mode & (0o077 if private else 0o022):
        raise ValueError()


def identities():
    if os.geteuid() != 0:
        raise ValueError()
    browser = pwd.getpwnam("otto-browser")
    workspace = pwd.getpwnam("node")
    connected = pwd.getpwnam("otto-connected")
    if (browser.pw_uid, browser.pw_gid, workspace.pw_uid, workspace.pw_gid) != (1001, 1001, 1000, 1000):
        raise ValueError()
    if (connected.pw_uid, connected.pw_gid) != (1002, 1002):
        raise ValueError()
    for path in ["/app", "/app/src", "/app/node_modules", "/opt/otto", "/opt/otto/computer-guard.py", "/opt/otto/workspace-command.py"]:
        trusted(path)
    trusted("/data", 1001, True)
    trusted("/home/otto-browser", 1001, True)
    trusted("/home/otto-connected", 1002, True)
    trusted("/run/otto", 0, True)
    if pathlib.Path("/usr/bin/sudo").exists() or pathlib.Path("/bin/sudo").exists():
        raise ValueError()


def network_rules():
    addresses = {4: set(), 6: set()}
    for interface in json.loads(command(["/usr/sbin/ip", "-json", "address", "show"])):
        for item in interface.get("addr_info", []):
            address = ipaddress.ip_address(item["local"])
            addresses[address.version].add(str(address))
    resolvers = {4: set(), 6: set()}
    for line in pathlib.Path("/etc/resolv.conf").read_text().splitlines():
        fields = line.split()
        if fields and fields[0] == "nameserver":
            address = ipaddress.ip_address(fields[1])
            resolvers[address.version].add(str(address))
    if not any(resolvers.values()):
        raise ValueError()
    lines = ["table inet otto {", "chain workspace_output {", "type filter hook output priority -150; policy accept;", "meta skuid != { 1000, 1002 } return"]
    for family, version in [("ip", 4), ("ip6", 6)]:
        if resolvers[version]:
            destinations = ", ".join(sorted(resolvers[version]))
            lines.extend(f"{family} daddr {{ {destinations} }} {protocol} dport 53 accept" for protocol in ["udp", "tcp"])
    lines.append("tcp dport 49983 reject")
    blocked = {
        4: {"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"},
        6: {"::/128", "::1/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8"},
    }
    for family, version in [("ip", 4), ("ip6", 6)]:
        for destination in sorted(blocked[version] | addresses[version]):
            lines.append(f"{family} daddr {destination} reject")
    lines.extend(["}", "}", ""])
    return "\n".join(lines).encode()


def firewall_state():
    value = json.loads(command(["/usr/sbin/nft", "--json", "list", "table", "inet", "otto"]))
    if not isinstance(value, dict) or set(value) != {"nftables"}:
        raise ValueError()
    def normalize(item):
        if isinstance(item, dict):
            return {key: normalize(data) for key, data in item.items() if key not in ["handle", "metainfo"]}
        if isinstance(item, list):
            return [normalize(data) for data in item if not isinstance(data, dict) or "metainfo" not in data]
        return item
    return hashlib.sha256(json.dumps(normalize(value), sort_keys=True).encode()).hexdigest()


def install():
    identities()
    if pathlib.Path("/run/otto/firewall.json").exists():
        raise ValueError()
    tables = json.loads(command(["/usr/sbin/nft", "--json", "list", "tables"]))
    if any(item.get("table", {}).get("family") == "inet" and item["table"].get("name") == "otto" for item in tables["nftables"]):
        raise ValueError()
    rules = network_rules()
    command(["/usr/sbin/nft", "--check", "--file", "-"], rules)
    command(["/usr/sbin/nft", "--file", "-"], rules)
    saved = {"rules": hashlib.sha256(rules).hexdigest(), "state": firewall_state()}
    descriptor = os.open("/run/otto/firewall.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(saved, output)
        output.flush()
        os.fsync(output.fileno())


def browser_environment():
    return {"HOME": "/home/otto-browser", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}


def browser_identity():
    os.setgroups([])
    os.setgid(1001)
    os.setuid(1001)
    os.umask(0o077)


def check():
    identities()
    trusted("/run/otto/firewall.json", 0, True)
    saved = json.loads(pathlib.Path("/run/otto/firewall.json").read_text())
    if saved != {"rules": hashlib.sha256(network_rules()).hexdigest(), "state": firewall_state()}:
        raise ValueError()
    result = subprocess.run(["/usr/local/bin/node", "--import", "tsx", "/app/deployment/e2b/browser-ready.ts"], cwd="/app", env=browser_environment(), preexec_fn=browser_identity, capture_output=True, timeout=5, check=True)
    if result.stdout or result.stderr:
        raise ValueError()


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ["start", "check"]:
        raise ValueError()
    if sys.argv[1] == "check":
        check()
        print('{"ready":true}')
        return
    install()
    browser_identity()
    os.chdir("/app")
    os.execve("/usr/local/bin/node", ["node", "--import", "tsx", "/app/src/providers/container-browser/worker.ts"], browser_environment())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("The private computer is not ready.\n")
        sys.exit(1)
