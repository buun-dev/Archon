#!/usr/bin/env bash
# init-firewall.sh — default-deny egress with a hostname allowlist.
# Runs as root inside the agent container (needs NET_ADMIN). Fail-closed.
# Exit codes: 2 allowlist missing or empty; 3 an allowlisted host does not
# resolve; 4 unsupported environment (no dnsmasq, empty upstream, more than one
# connected network).
set -euo pipefail

ALLOWLIST="${1:-/etc/archon/allowlist.txt}"
[ -f "$ALLOWLIST" ] || { echo "FATAL: allowlist not found: $ALLOWLIST" >&2; exit 2; }

# Close egress before touching anything, and never open it again. A re-run on
# an already-firewalled container (resume, or a second invocation) would
# otherwise be open for the whole script, and a run that fails part-way would
# leave it open. Nothing before the rules needs the network: ipset and dnsmasq
# startup are local, and the allowlist is resolved after the rules.
iptables -P OUTPUT DROP
iptables -F OUTPUT
# Drop rules referencing the set (the flush above) BEFORE destroying it, so a
# re-invocation doesn't die under set -e.
ipset destroy archon-allow 2>/dev/null || true
# `timeout` matters because dnsmasq adds entries continuously: without it the
# set would grow for the life of the container. Entries refresh on re-resolution.
ipset create archon-allow hash:ip family inet timeout 3600

HOSTS=()
while read -r host; do
  [ -z "$host" ] && continue
  case "$host" in \#*) continue ;; esac
  HOSTS+=("$host")
done < "$ALLOWLIST"
[ ${#HOSTS[@]} -gt 0 ] || { echo "FATAL: allowlist has no hosts" >&2; exit 2; }

# ─── Resolve-time enforcement ────────────────────────────────────────────────
# The policy is written in HOSTNAMES but iptables enforces IP ADDRESSES, and DNS
# sits in the gap. Resolving once at startup and pinning the answer is wrong for
# any rotating CDN: fonts.gstatic.com returns a DIFFERENT A record every ~2s, so
# the pinned IP is stale long before the agent connects. Measured 2026-09-08 —
# fonts.googleapis.com had been on this allowlist for two months and had never
# once worked, and the failure reads as a flaky network, not as a firewall.
#
# dnsmasq closes the gap by adding each resolved IP to the ipset AS IT ANSWERS
# THE QUERY, so an address is allowed at the instant the process is about to use
# it. It also closes the DNS side channel: a name outside this file does not
# resolve at all (NXDOMAIN), so DNS cannot carry data out. Only allowlisted
# names, their subdomains, and dotless names (compose service and container
# names) are forwarded.
#
# The upstream is the resolver the container STARTED with. Docker restores
# /etc/resolv.conf on every container restart, so the file is not needed for
# that; it is what keeps a re-run INSIDE A RUNNING container from forwarding
# dnsmasq to itself, because this script rewrites resolv.conf to point at its
# own dnsmasq and every lookup (the compose `db` service included) would then
# time out.
UPSTREAM_FILE=/etc/archon-dns-upstream
if [ -s "$UPSTREAM_FILE" ]; then
  UPSTREAM="$(cat "$UPSTREAM_FILE")"
else
  UPSTREAM="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf || true)"
  [ -n "$UPSTREAM" ] && printf '%s\n' "$UPSTREAM" > "$UPSTREAM_FILE"
fi

# Only dnsmasq can refuse unlisted names, so there is no fallback: without it
# the firewall refuses and egress stays closed.
command -v dnsmasq >/dev/null 2>&1 \
  || { echo "FATAL: dnsmasq is not installed; the runner image must include it" >&2; exit 4; }
[ -n "$UPSTREAM" ] \
  || { echo "FATAL: no upstream DNS resolver found in /etc/resolv.conf" >&2; exit 4; }

HOSTS_SLASH="$(IFS=/; printf '%s' "${HOSTS[*]}")"
# One self-contained config; deliberately NOT the distro's /etc/dnsmasq.conf,
# so a base-image change cannot quietly alter resolver behaviour here.
#   server=/a/b/UP  forwards each listed name and its subdomains
#   server=//UP     forwards dotless names (compose services, container names)
#   address=/#/     answers every other name NXDOMAIN
#   ipset=/a/b/set  covers the same names, so what resolves is what gets allowed
{ printf 'no-resolv\nno-hosts\nlisten-address=127.0.0.1\nbind-interfaces\nport=53\n'
  printf 'server=/%s/%s\n' "$HOSTS_SLASH" "$UPSTREAM"
  printf 'server=//%s\n' "$UPSTREAM"
  printf 'address=/#/\n'
  printf 'ipset=/%s/archon-allow\n' "$HOSTS_SLASH"
} > /etc/archon-dnsmasq.conf

# A re-run in a running container must not race the old dnsmasq for port 53.
pkill -x dnsmasq 2>/dev/null || true
for _ in $(seq 50); do
  pgrep -x dnsmasq >/dev/null 2>&1 || break
  sleep 0.1
done
dnsmasq --conf-file=/etc/archon-dnsmasq.conf \
  || { echo "FATAL: dnsmasq failed to start" >&2; exit 4; }
# Point the container at the local resolver. /etc/resolv.conf is a bind mount,
# so truncate-in-place — it cannot be replaced.
printf 'nameserver 127.0.0.1\n' > /etc/resolv.conf

# /proc/net/route stores addresses as little-endian hex (iproute2 is not in the
# image): 010015AC is 172.21.0.1.
hex_ip() {
  local h=$1
  printf '%d.%d.%d.%d' "$((16#${h:6:2}))" "$((16#${h:4:2}))" "$((16#${h:2:2}))" "$((16#${h:0:2}))"
}

# Local traffic is limited to the one directly connected network, minus its
# gateway. The gateway is the WSL VM, where other stacks' published ports and
# distro services listen. Only the default route's gateway is visible from
# inside, so a second network's gateway could not be excluded: refuse instead.
GATEWAY=""
SUBNETS=()
while read -r _ dest gw _ _ _ _ mask _; do
  if [ "$dest" = "00000000" ]; then
    [ -z "$GATEWAY" ] && GATEWAY="$(hex_ip "$gw")"
  elif [ "$gw" = "00000000" ]; then
    SUBNETS+=("$(hex_ip "$dest")/$(hex_ip "$mask")")
  fi
done < <(tail -n +2 /proc/net/route)
if [ ${#SUBNETS[@]} -gt 1 ]; then
  echo "FATAL: the agent is on more than one network (${SUBNETS[*]}); the sandbox firewall supports exactly one" >&2
  exit 4
fi
SUBNET="${SUBNETS[0]:-}"

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
# DNS only to the upstream. On a compose network that is Docker's 127.0.0.11,
# reached over `lo`; dockerd forwards it from the host namespace
# (`ExtServers: [host(…)]`), so no DNS packet leaves the container. This rule is
# what admits an off-box upstream (an agent on the default bridge).
iptables -A OUTPUT -d "$UPSTREAM" -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -d "$UPSTREAM" -p tcp --dport 53 -j ACCEPT
if [ -n "$GATEWAY" ]; then
  iptables -A OUTPUT -d "$GATEWAY" -j REJECT --reject-with icmp-port-unreachable
fi
if [ -n "$SUBNET" ]; then
  iptables -A OUTPUT -d "$SUBNET" -j ACCEPT
fi
iptables -A OUTPUT -m set --match-set archon-allow dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable

# Seed the set. This runs through the fresh dnsmasq under the final firewall, so
# it also proves the resolver path works. A host that cannot resolve is fatal —
# a typo must not silently become an open hole.
for host in "${HOSTS[@]}"; do
  ips=$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u)
  [ -z "$ips" ] && { echo "FATAL: cannot resolve $host" >&2; exit 3; }
  for ip in $ips; do ipset add archon-allow "$ip" -exist; done
done

if [ -n "$SUBNET" ]; then
  if [ -n "$GATEWAY" ]; then
    LOCAL="$SUBNET (gateway $GATEWAY rejected)"
  else
    LOCAL="$SUBNET (no gateway)"
  fi
else
  LOCAL="none"
fi
echo "init-firewall: OUTPUT default-deny active; dns=allowlist via $UPSTREAM; local=$LOCAL; $(ipset list archon-allow | grep -c '^[0-9]') allowlist IPs"
