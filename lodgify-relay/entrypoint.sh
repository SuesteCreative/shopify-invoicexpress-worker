#!/bin/sh
# FAIL-CLOSED GUARD — the reason this script exists instead of a plain
# ENTRYPOINT ["caddy", ...].
#
# In a Caddyfile, `{$VAR}` expands to nothing when the variable is missing, and
# `header X-Rioko-Gateway-Key ""` matches the mere PRESENCE of the header.
# Negated in the @unauthed matcher, that means "any request carrying the header
# passes" — an unset secret would silently OPEN the relay rather than break it.
# Refuse to start at all instead.
set -eu

if [ -z "${GW_KEY_A:-}" ]; then
	echo "refusing to start: GW_KEY_A is unset. The relay would accept any request." >&2
	exit 1
fi

# Short secrets are the only control here. The hostname is public within minutes
# of Fly issuing a certificate (Certificate Transparency), so obscurity is zero.
if [ "${#GW_KEY_A}" -lt 32 ]; then
	echo "refusing to start: GW_KEY_A is shorter than 32 characters." >&2
	exit 1
fi

# Second accepted value, for rotating without an outage. Defaulting it to A is
# deliberate: an empty B would hit the match-any-header trap described above.
GW_KEY_B="${GW_KEY_B:-$GW_KEY_A}"
export GW_KEY_B

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
