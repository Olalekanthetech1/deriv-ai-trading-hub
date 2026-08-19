# Dedicated ML Training Worker

## Purpose

Long-running model training is submitted by the Next.js application as a durable database-backed job. The Next.js web service does not hold an HTTP request open for native model fitting and does not own the training worker process.

## Runtime boundary

```text
Admin UI
  -> Next.js training API
  -> ml_training_job_queue (Postgres)
  -> Render ML Worker
  -> native Python ML daemon
  -> training run + model artifact + registry
```

The web service remains responsible for authentication, validation, queue submission, diagnostics and lifecycle display. The worker owns native training execution.

## Worker lifecycle

- Worker publishes a persistent heartbeat while idle and while training.
- Jobs are claimed atomically with `FOR UPDATE SKIP LOCKED`.
- Only one queued/running job is allowed per dataset at a time.
- A worker crash stops heartbeats; stale recovery returns the queue job to `queued`.
- Existing `ml_training_runs` reconciliation remains authoritative for the actual training run and never turns a timed-out run into success.
- Batch items and batch summaries are updated from worker results rather than browser state.

## Render services

- `deriv-ai-trading-hub`: Next.js web service on port 3000.
- `deriv-ai-ml-worker`: dedicated Render background worker using `npm run ml:worker`.

Both services use the same image and database. Only the worker starts the long-running training loop.

## Transformer

Transformer remains an experimental model and is excluded from the default production-candidate model list. It can be evaluated separately through the Experimental Lab after the worker boundary is deployed.

## TensorFlow.js

TensorFlow.js remains a future optional edge-inference runtime. No TensorFlow.js dependency or production edge inference contract is added by this change.
