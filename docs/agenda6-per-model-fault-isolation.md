# Agenda 6: Per-model fault isolation

A native model timeout is a terminal state for that model, not an automatic cancellation of sibling queued models. The training run continues through the remaining requested models and records timeout counts in run metadata. Worker-heartbeat stale recovery remains run-level and may still reconcile the whole run when the worker itself becomes unobservable.

Acceptance:
- timed_out model remains explicitly timed_out;
- sibling queued models continue;
- no timeout is converted into success;
- timeout count is persisted in run metadata;
- dynamic ML_TRAINING_TIMEOUT_MS and ML_TRAINING_STALE_AFTER_MS remain authoritative.
