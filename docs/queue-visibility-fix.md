# Training queue visibility fix

The training diagnostics API now hydrates queued/running/failed worker jobs into the existing run-history lifecycle until the native worker creates the authoritative training-run record. The durable Postgres queue remains the source of truth for pre-run state.