# Edge auth deployment

This repository contains a small, independent Node service for NGINX
`auth_request` integration. It is intentionally separate from the main API
workers so disabled or unknown API keys can be rejected before provider,
quota, proxy, and model-routing code runs.

## Phase-one behavior

- Active keys use a configurable high RPM ceiling (default `100000/minute`).
- Disabled, revoked, expired, unknown, malformed, and missing keys are rejected.
- IP RPM is measured in Redis, but enforcement is disabled by default.
- Redis failure uses a bounded local fail-open guard (`120/minute` by default).
- Existing Node provider/key concurrency controls remain authoritative.

The edge service does not acquire a long-lived concurrency lease. NGINX
`auth_request` has no reliable callback after the proxied upstream request
finishes, so acquiring a Redis lease there would leak slots until a TTL. Keep
the existing Node concurrency controller until a gateway with request-lifecycle
hooks is introduced.

## Local smoke test

```powershell
$env:REDIS_URL = 'redis://127.0.0.1:6379/0'
$env:EDGE_AUTH_POLICY_FILE = 'configs/api-potluck-keys.json'
node src/edge-auth/server.js
```

The service listens on `127.0.0.1:18081` by default. `GET /authorize` returns
204 for allowed requests, 401 for missing/unknown keys, 403 for disabled
keys, and 429 for a rate violation. `GET /health` returns 200.

## NGINX wiring

Include the `limit_req_zone` and `map` directives from
`docker/nginx-edge-auth.conf` inside the `http {}` block. Include the
`location = /_edge_auth` block from `docker/nginx-edge-auth-location.conf`
inside each TLS/plain HTTP `server {}` block.
Add these directives to the API locations that should be protected:

Include `docker/nginx-edge-auth-api-location.conf` in each protected API
location. It enables `auth_request` and IP dry-run observability with the
phase-one high threshold.

`limit_req_dry_run on` means the IP rule records would-be rejections without
blocking. Remove `limit_req_dry_run on` only after selecting an IP policy.

The subrequest forwards Bearer, `x-api-key`, `x-goog-api-key`, and the current
`?key=`/`?api_key=` query values. It also forwards the trusted NGINX
`$remote_addr` as `X-Edge-Client-IP`; do not trust a client-supplied forwarded
IP header in edge-auth.

## Compose

`docker/docker-compose.edge-auth.yml` is an override-style service definition.
Run it together with the existing compose file after reviewing the image build
and volume paths. It does not modify the active production container or NGINX.
