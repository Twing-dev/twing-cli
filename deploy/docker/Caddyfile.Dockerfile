# Stock `caddy:2` has no rate-limiting directive built in -- it needs
# github.com/mholt/caddy-ratelimit, a third-party module, which only exists
# in a Caddy binary compiled with it in. `caddy:2-builder` is Docker's own
# official image for exactly this (bundles xcaddy); the runtime stage stays
# on plain `caddy:2` and just swaps in the custom-built binary, so nothing
# else about the deployment (Caddyfile mount, named volumes, ports) changes.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
