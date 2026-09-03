# Standard Caddy. No plugins: `dynamic a` (the IPv4-only upstream resolver) and
# the log filter encoder are both in the standard build, so there is no xcaddy
# step and nothing to rebuild when Caddy releases.
FROM caddy:2-alpine

# curl, for the verification steps in README.md. They have to run from INSIDE a
# machine — proving what Lodgify sees is the whole point, and busybox's wget
# cannot be trusted with HTTPS here. Keep it: the day this relay misbehaves,
# `fly ssh console` with no HTTP client is a bad place to start.
RUN apk add --no-cache curl

COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Fly terminates TLS at its edge and forwards plain HTTP here.
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
