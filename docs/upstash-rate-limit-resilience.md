# Upstash Rate-Limit Resilience

## Incident

Production logs showed repeated `UpstashError: ERR max requests limit exceeded` from the global API proxy. The proxy was calling the distributed Upstash limiter for every `/api/*` request, including high-frequency ML/status/telemetry polling.

## Production policy

- Distributed Upstash limiting remains authoritative for security-sensitive API, ML, and authentication traffic when Redis is available.
- High-frequency read-only telemetry/status endpoints use a process-local limiter and do not consume Upstash request quota.
- If Upstash is unavailable or its request quota is exhausted, the application falls back to the process-local limiter instead of turning the request into an internal 500.
- Rate-limit accounting must never become a single point of failure for application availability.
- Block metrics are best-effort and must not trigger additional Redis calls on the request hot path.

## Verification gate

A production deployment is not considered healthy until:

1. `/api/ml/status` can be polled continuously without increasing Upstash request usage.
2. An Upstash request-limit/quota failure does not cause the Next.js service to crash or return an internal error from the proxy.
3. Authentication and mutation endpoints still use the distributed limiter when Redis is healthy.
4. The local fallback remains bounded and expires keys after their configured window.
