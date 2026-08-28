# Multi-worker state audit

This document records the current ownership contract for state used by the
control worker and execution workers. It is a design/diagnostic reference;
runtime usage data and credentials do not belong here.

| State | Semantics | Owner / coordination | Finding |
| --- | --- | --- | --- |
| Potluck daily admitted/reserved quota | `strict-global` | Redis Lua quota scripts | Must be checked before provider selection; reservations are idempotent. |
| Potluck `todayUsage` | `eventually-consistent` | Control-worker usage projection and durable persistence | Not safe for admission in execution workers; now used only as a monotonic Redis baseline. |
| Potluck reservation / request dedupe | `strict-global` | Redis reservation and dedupe keys | Prevents cross-worker admission and settlement duplication. |
| Potluck token counters and `usageHistory` | `eventually-consistent` | Control-worker projection, usage ledger | Detailed accounting remains outside Redis quota keys. |
| `pendingUsage` | `request-local` | Same request lifecycle / runtime hook projection | Bounded by request lifecycle; cleanup occurs after content completion. |
| `rateManager` | `worker-local` | Each worker | QPS/RPM/TPS display metric, not a hard quota. |
| Provider active leases | `strict-global` | Redis Lua lease coordinator | Existing lease TTL, renew and release path retained. |
| Potluck concurrency leases / queue reservations | `strict-global` | Redis Lua lease coordinator | Existing cross-worker coordination retained. |
| Gemini queue leases | `strict-global` | Redis Lua lease coordinator | Existing global, per-key and byte limits retained. |
| Image capacity leases | `strict-global` | Redis Lua lease coordinator | Existing renew/recovery behavior retained. |
| Refresh fences and model cooldowns | `strict-global` | Redis Lua lease coordinator | Existing fencing and TTL semantics retained. |
| Provider config revisions | `eventually-consistent` | Control worker publishes; execution workers acknowledge | Readiness requires all execution workers to converge. |
| Provider health / quota snapshots | `eventually-consistent` | State events and local provider managers | Health is observational and must not be confused with Potluck request quota. |
| Round-robin cursors and selection locks | `worker-local` | Each provider-pool manager | Affects fairness/performance only. |
| Refresh queues and in-flight refresh maps | `worker-local` | Each provider-pool manager | Duplicate refreshes are bounded by local/fence checks; not request admission. |
| Prompt cache key resolution | `strict-global` | Redis Lua cache-key script | Existing shared cache affinity retained. |
| Runtime hook backlog / recovery barrier | `strict-global` | Redis stream and worker boot barrier | Hook delivery is durable; quota reservation metadata crosses the bridge. |

## Operational signals

`/runtime/health` and aggregated runtime metrics expose Potluck quota counters:

- quota mode (`distributed-strict`, `local-degraded`, or `local-only`)
- local degraded requests and local rejects
- Redis coordination and finalization errors
- local reservation and pending usage counts
- coordinator reservation, reject, settle, release, idempotent and error counters

The current deployment policy keeps `local-degraded` as the default fallback.
Set `POTLUCK_DISTRIBUTED_QUOTA_FAILURE_MODE=fail-closed` when strict admission
is more important than availability.
