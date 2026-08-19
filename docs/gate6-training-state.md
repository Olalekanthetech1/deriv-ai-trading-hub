# Gate 6 training state

Training batches are durable database state. A browser refresh or a Render deployment does not mean a batch is new or active.

The batch queue now reconciles stale queued/running/partial batches when there are no active queue jobs for a configurable grace period (`ML_TRAINING_BATCH_STALE_AFTER_MS`, default 5 minutes). This prevents an orphaned batch row from permanently blocking new plans.

The API also returns the active batch identifier/status when a real active batch blocks a new request.

Never delete or reset active training runs to hide the guard. Reconcile only when queue/worker evidence shows the batch is no longer active.
