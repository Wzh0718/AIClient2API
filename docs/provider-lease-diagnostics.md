# Provider lease diagnostics

Provider concurrency leases belong to the HTTP request that acquired them. Each lease ID is tracked separately, including repeated acquisitions of the same credential. Selection failures roll back only leases acquired by that selection; response finish, close, and handler completion clean up remaining request-owned leases. Release stops renewal before contacting Redis. If Redis is unavailable, the lease expires by its existing TTL.

An eligible pool at concurrency capacity returns HTTP 429 with `PROVIDER_CONCURRENCY_EXHAUSTED`. No eligible credentials still returns 503. Model cooldown retains its existing classification. This change does not add queueing or impose a maximum request duration.

## Management query

`GET /api/provider-leases` requires the existing management login token. A normal Potluck API key does not authorize this management route. Optional query parameters are `providerType` and `providerUuid`; filter values allow letters, digits, underscores, and hyphens, up to 128 characters.

The response has `epoch`, `leases`, `accounts`, `total`, and `truncated`. Each lease has `leaseId`, `providerType`, `providerUuid`, `requestId`, `workerId`, `keyRef`, `model`, `createdAt`, and `expiresAt`. Times are Unix milliseconds. Account rows contain `providerType`, `providerUuid`, and `activeCount`. `keyRef` uses the same `sha256:` plus 16 hex characters as request audit, and can be correlated with the audit event's `potluckKey.hash`.

The query reads only effective active members from the current deployment namespace, without pruning or renewing them. Up to 200 leases are returned. `truncated` indicates a result limit or a bounded Redis scan; when the scan is incomplete, `total` and `accounts` cover the scanned keys only. A missing legacy ownership field is `null`, not an inferred request or key. Responses use `Cache-Control: no-store`; invalid filters return 400, and unavailable coordination returns 503 rather than an empty list.

Structured `[Provider Lease]` events record acquisition, release, and release failure with request ID, worker, provider UUID, model, and hashed key reference. They do not contain raw API keys, prompts, or OAuth data. Lease records remain temporary Redis data; lifecycle logs follow existing service log retention.

Do not delete active lease keys as a recovery shortcut: live workers may keep renewing or reconstruct them. Capture occupancy and request evidence first, then use the separately authorized deployment or maintenance workflow.
