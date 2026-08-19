# ML Model Lab Architecture

## Purpose

The training system separates model experimentation from production promotion. A successful training run is evidence that a model artifact was produced; it is not evidence that the artifact is production-ready.

## Model tiers

### Production candidates

The default training set contains:

- XGBoost
- LightGBM
- CatBoost
- TCN
- LSTM / GRU
- HMM Regime Model
- Isolation Forest

These models may be trained by the normal batch-training workflow and are registered as `candidate` after a successful run.

### Experimental Lab

Transformer is intentionally retained as an explicit experimental model. It is excluded from the default `all` training selection so a resource-heavy or unstable experimental model cannot block the production-candidate training set.

The existing `/admin/experiments` area is the controlled research surface. Experimental models must remain outside the production promotion path until they pass evaluation and operational-readiness checks.

## Lifecycle

```text
TRAINING
   -> candidate
   -> evaluation / backtest / walk-forward validation
   -> staging
   -> explicit promotion
   -> production
```

A failed, timed-out, or stale training attempt never becomes a candidate merely because the process later restarts.

## Runtime boundary

The native daemon remains the authoritative training runtime. The web application orchestrates jobs, validates requests, persists lineage, and displays diagnostics; it does not perform heavyweight model fitting inside the Next.js request process.

TensorFlow.js is considered a future **runtime/edge inference option**, not a model family. It should only be introduced when a validated model can be exported safely and an explicit browser/edge inference contract exists. Adding TensorFlow.js does not make a model production-ready.

## Promotion requirements

Promotion must be explicit and evidence-based. At minimum, the candidate should have:

1. Valid dataset lineage and schema fingerprint.
2. Leakage validation passed.
3. Reproducible training metadata.
4. Validation metrics beyond accuracy where applicable.
5. Walk-forward or equivalent out-of-sample evaluation.
6. Inference latency and resource measurements appropriate to the deployment runtime.
7. No unresolved training/runtime faults.
8. Explicit promotion action by an authorized admin workflow.

## Design rule

Never infer production readiness from `training succeeded`. The registry status is the source of lifecycle truth.