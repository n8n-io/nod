#!/bin/sh
set -eu
export XTABLES_LOCKFILE=/tmp/xtables.lock
rm -f /tmp/network-ready
ip6tables-restore --wait 10 <<'RULES'
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A OUTPUT -o lo -j ACCEPT
COMMIT
RULES
{
  printf '%s\n' '*filter' ':INPUT ACCEPT [0:0]' ':FORWARD DROP [0:0]' ':OUTPUT ACCEPT [0:0]' '-A OUTPUT -o lo -j ACCEPT'
  for server in $(awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print $2 }' /etc/resolv.conf); do
    printf '%s\n' "-A OUTPUT -d $server -p udp -m udp --dport 53 -j ACCEPT" "-A OUTPUT -d $server -p tcp -m tcp --dport 53 -j ACCEPT"
  done
  for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/3; do
    printf '%s\n' "-A OUTPUT -d $range -j REJECT"
  done
  printf '%s\n' 'COMMIT'
} | iptables-restore --wait 10
touch /tmp/network-ready
exec sleep infinity
