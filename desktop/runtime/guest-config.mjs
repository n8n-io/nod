export const protectGuest = `#!/bin/bash
set -euo pipefail
cat > /etc/apt/apt.conf.d/99-nod-kernel.tmp <<'APT'
Unattended-Upgrade::Package-Blacklist { "^linux-"; "^grub"; "^shim"; };
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "false";
APT
mv /etc/apt/apt.conf.d/99-nod-kernel.tmp /etc/apt/apt.conf.d/99-nod-kernel
test "$(cat /sys/module/apparmor/parameters/enabled)" = Y
cat > /etc/apparmor.d/nod-docker.tmp <<'PROFILE'
abi <abi/3.0>,
#include <tunables/global>
profile docker-default flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  network,
  capability,
  file,
  umount,
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer=docker-default,
  signal (send,receive) peer="docker-default//&unconfined",
  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9],[^1-9][^0-9],[^1-9s][^0-9y][^0-9s],[^1-9][^0-9][^0-9][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny mount,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,
  ptrace (trace,read,tracedby,readby) peer=docker-default,
  ptrace (trace,read,tracedby,readby) peer="docker-default//&unconfined",
}
PROFILE
apparmor_parser -Kr /etc/apparmor.d/nod-docker.tmp
mv /etc/apparmor.d/nod-docker.tmp /etc/apparmor.d/nod-docker
grep -Fxq 'docker-default (enforce)' /sys/kernel/security/apparmor/profiles
`;

export function guestConfiguration({
  assets,
  imageDigest,
  port,
  memory,
  cpus,
  arch = process.platform === 'darwin' && process.arch === 'x64' ? 'x86_64' : 'aarch64',
}) {
  return {
    minimumLimaVersion: '2.2.0',
    vmType: 'vz',
    arch,
    images: [{ location: `${assets}/guest.img`, arch, digest: `sha256:${imageDigest}` }],
    cpus,
    memory: `${memory}GiB`,
    disk: '24GiB',
    mountType: 'virtiofs',
    mounts: [{ location: assets, mountPoint: '/opt/nod-assets', writable: false }],
    user: { name: 'nod', uid: 1000, home: '/home/nod', shell: '/bin/bash' },
    ssh: { loadDotSSHPubKeys: false, forwardAgent: false, forwardX11: false },
    containerd: { system: false, user: false },
    hostResolver: { enabled: true, ipv6: false },
    portForwards: [
      { guestSocket: '/var/run/docker.sock', hostSocket: '{{.Dir}}/sock/docker.sock' },
      { guestIP: '127.0.0.1', guestPort: 54329, hostIP: '127.0.0.1', hostPort: port, static: true },
      { guestPortRange: [1, 65535], ignore: true },
    ],
    provision: [
      {
        mode: 'dependency',
        skipDefaultDependencyResolution: true,
        script: `${protectGuest}
export DEBIAN_FRONTEND=noninteractive
if ! command -v iptables >/dev/null; then
  apt-get install -y --no-install-recommends /opt/nod-assets/guest-packages/*.deb || {
    apt-get -o Acquire::Retries=3 update
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends iptables
  }
fi
`,
      },
      {
        mode: 'system',
        script: `#!/bin/bash
set -euo pipefail
tar -xzf /opt/nod-assets/docker-guest.tar.gz --strip-components=1 -C /usr/local/bin
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{"storage-driver":"overlay2","userland-proxy":false,"iptables":true,"ip6tables":false,"ipv6":false,"log-driver":"local","log-opts":{"max-size":"10m","max-file":"2"}}
JSON
cat > /etc/systemd/system/nod-docker.service <<'UNIT'
[Unit]
Description=nod private container runtime
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
ExecStart=/usr/local/bin/dockerd --host=unix:///var/run/docker.sock
ExecStartPost=/bin/chown nod /var/run/docker.sock
Restart=on-failure
TimeoutStartSec=120
LimitNOFILE=1048576
Delegate=yes
KillMode=process
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now nod-docker.service
`,
      },
    ],
    probes: [
      {
        mode: 'readiness',
        description: 'Nod container runtime',
        script: '#!/bin/bash\nset -e\nsudo /usr/local/bin/docker info >/dev/null\n',
      },
    ],
  };
}

export const protectNetworks = `#!/bin/bash
set -euo pipefail
{
printf '%s\\n' '*filter' ':NOD-WORKLOADS - [0:0]' '-F NOD-WORKLOADS'
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/3; do
  printf '%s\\n' "-A NOD-WORKLOADS -d $range -j REJECT"
done
printf '%s\\n' '-A NOD-WORKLOADS -j RETURN' 'COMMIT'
} | iptables-restore --wait 10 --noflush
for interface in nod-workspace nod-browser; do
  iptables -w 10 -C DOCKER-USER -i "$interface" -j NOD-WORKLOADS 2>/dev/null || iptables -w 10 -I DOCKER-USER 1 -i "$interface" -j NOD-WORKLOADS
  iptables -w 10 -C INPUT -i "$interface" -j DROP 2>/dev/null || iptables -w 10 -I INPUT 1 -i "$interface" -j DROP
done
iptables -w 10 -C DOCKER-USER -i nod-control -m conntrack --ctstate NEW -j REJECT 2>/dev/null || iptables -w 10 -I DOCKER-USER 1 -i nod-control -m conntrack --ctstate NEW -j REJECT
`;
