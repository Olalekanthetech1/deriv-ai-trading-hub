# Sequence Training Queue

The sequence-training queue preserves explicit dataset lineage for multi-horizon training jobs.

A Unified Multi-Horizon job is identified by `sourceDatasetId + horizonKey`; a legacy duration job is identified by `datasetId`.

The queue intentionally remains separate from `ml_training_job_queue` until the existing worker contract is migrated. This prevents a partial migration from making a queued Unified job look like a standard duration dataset to the legacy worker.
