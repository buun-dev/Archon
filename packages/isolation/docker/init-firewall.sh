#!/usr/bin/env bash
# init-firewall.sh — default-deny egress with a hostname allowlist.
# Runs as root inside the agent container (needs NET_ADMIN). Fail-closed.
set -euo pipefail

ALLOWLIST="${1:-/etc/archon/allowlist.txt}"
[ -f "$ALLOWLIST" ] || { echo "FATAL: allowlist not found: $ALLOWLIST" >&2; exit 2; }

# Idempotency (FIX-D): drop rules referencing the set BEFORE destroying it,
# so a re-invocation on an already-firewalled container doesn't die under set -e.
# The policy has to open again too: a flush leaves the DROP policy from the
# first run in place with no ACCEPT rule at all, so the resolve loop below —
# and dnsmasq's forwarding, and loopback itself — would get nothing until the
# rules are re-added at the end. Egress is default-deny again by then.
iptables -F OUTPUT
iptables -P OUTPUT ACCEPT
ipset destroy archon-allow 2>/dev/null || true
# `timeout` matters now that dnsmasq adds entries continuously: without it the
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
# it. The POLICY IS UNCHANGED: only names in this file are ever added, and every
# other destination still hits the final REJECT.
# The upstream is the resolver the container STARTED with, remembered across
# re-invocations: this script rewrites /etc/resolv.conf to point at its own
# dnsmasq, so a second run that read the file afresh would forward dnsmasq to
# itself and every lookup — the compose `db` service included — would time out.
UPSTREAM_FILE=/etc/archon-dns-upstream
if [ -s "$UPSTREAM_FILE" ]; then
  UPSTREAM="$(cat "$UPSTREAM_FILE")"
else
  UPSTREAM="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf || true)"
  [ -n "$UPSTREAM" ] && printf '%s
' "$UPSTREAM" > "$UPSTREAM_FILE"
fi
DNS_MODE="snapshot"

if command -v dnsmasq >/dev/null 2>&1 && [ -n "$UPSTREAM" ]; then
  # One self-contained config; deliberately NOT the distro's /etc/dnsmasq.conf,
  # so a base-image change cannot quietly alter resolver behaviour here.
  # `ipset=/a/b/c/setname` also covers subdomains of each name.
  { printf 'no-resolv\nno-hosts\nlisten-address=127.0.0.1\nbind-interfaces\nport=53\n'
    printf 'server=%s\n' "$UPSTREAM"
    printf 'ipset=/%s/archon-allow\n' "$(IFS=/; printf '%s' "${HOSTS[*]}")"
  } > /etc/archon-dnsmasq.conf

  pkill -x dnsmasq 2>/dev/null || true
  if dnsmasq --conf-file=/etc/archon-dnsmasq.conf; then
    # Point the container at the local resolver. /etc/resolv.conf is a bind mount,
    # so truncate-in-place — it cannot be replaced.
    printf 'nameserver 127.0.0.1\n' > /etc/resolv.conf
    DNS_MODE="dnsmasq"
  else
    echo "WARN: dnsmasq failed to start; falling back to snapshot mode" >&2
  fi
else
  echo "WARN: dnsmasq unavailable; falling back to snapshot mode (rotating CDNs will fail)" >&2
fi

# Seed the set. In dnsmasq mode this also proves the resolver path works; in
# snapshot mode it is the only thing populating the set. Either way a host that
# cannot resolve is fatal — a typo must not silently become an open hole.
for host in "${HOSTS[@]}"; do
  ips=$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u)
  [ -z "$ips" ] && { echo "FATAL: cannot resolve $host" >&2; exit 3; }
  for ip in $ips; do ipset add archon-allow "$ip" -exist; done
done

iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
# DNS to the container's resolver (compose network) — needed for runtime lookups.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
# Compose internal network (db service) — RFC1918; allow intra-project traffic.
iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -m set --match-set archon-allow dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable

echo "init-firewall: OUTPUT default-deny active; mode=$DNS_MODE; $(ipset list archon-allow | grep -c '^[0-9]') allowlist IPs"
