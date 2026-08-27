# Runtime Request Performance Observability

The API worker keeps low-overhead request stage metrics in memory and emits a
sanitized `[Request Perf]` log only when sampling or the slow-request threshold
selects the request. Profiles never retain prompt contents, image data, API
keys, bearer tokens, OAuth tokens, or cookies.

## Configuration

Set these values in `configs/config.json` or as process environment variables:

- `REQUEST_PERF_SAMPLE_RATE`: decimal value from `0` to `1`; `0` disables random
  request profile logging.
- `REQUEST_PERF_SLOW_MS`: slow-request threshold in milliseconds; `0` disables
  threshold-based profile logging.

For a short production observation window, use a small sample rate (for
example `0.01`) and a conservative slow threshold (for example `5000`). Reset
both values to `0` after the observation window if detailed logs are no longer
needed.

Each selected profile includes only the worker, request kind, status, total
duration, safe request metadata, stage durations, output bytes, and response
backpressure time. Plugin operations are reported as
`plugin:<plugin>:<operation>` stages, and durable hook bridge work is reported
as `runtimeHookBridge:<hook>` stages.
