"""Native one-fit training for a compatible multi-horizon tabular cohort.

The Node layer owns cohort membership and tick-property feature construction.
This module only consumes already-persisted canonical feature vectors and fits
one native classifier across the cohort. Horizon context is already part of
the canonical feature contract; the cohort metadata remains attached to the
artifact for lineage and downstream per-horizon validation.
"""
from __future__ import annotations

import math
import os
import pickle
import time
from pathlib import Path
from typing import Any

try:
    import numpy as np
except Exception:
    import pure_ml_engine as np

import ml_native_runtime as native

try:
    import xgboost as xgb
except Exception:
    xgb = None

try:
    import lightgbm as lgb
except Exception:
    lgb = None

try:
    import catboost as cb
except Exception:
    cb = None

try:
    from sklearn.metrics import accuracy_score, f1_score, log_loss
except Exception:
    import pure_ml_engine as _pure
    accuracy_score = _pure.accuracy_score
    f1_score = _pure.f1_score
    log_loss = _pure.log_loss

MODEL_DIR = Path(os.getenv("MODEL_CACHE_DIR", str(Path(__file__).resolve().parent.parent / "models_cache")))
MODEL_DIR.mkdir(parents=True, exist_ok=True)


def _dataset(payload: dict[str, Any], key: str) -> tuple[np.ndarray, np.ndarray]:
    data = payload.get(key)
    if not isinstance(data, dict):
        raise ValueError(f"{key.upper()}_REQUIRED")
    vectors = data.get("featureVectors")
    labels = data.get("labels")
    if not isinstance(vectors, list) or not isinstance(labels, list) or len(vectors) != len(labels) or not vectors:
        raise ValueError(f"INVALID_{key.upper()}")
    schema = native.require_schema()
    if int(data.get("featureCount", -1)) != schema["featureCount"]:
        raise ValueError("FEATURE_DATASET_SCHEMA_MISMATCH")
    if data.get("schemaFingerprint") != schema["schemaFingerprint"]:
        raise ValueError("FEATURE_DATASET_FINGERPRINT_MISMATCH")
    X = np.asarray([native.validate_vector(row) for row in vectors], dtype=np.float32)
    y = np.asarray([int(value) for value in labels], dtype=np.int64)
    return X, y


def _fit(kind: str, X: np.ndarray, y: np.ndarray, hyper: dict[str, Any], threads: int):
    if kind == "xgboost":
        if xgb is None:
            raise RuntimeError("XGBOOST_RUNTIME_UNAVAILABLE")
        model = xgb.XGBClassifier(
            n_estimators=int(hyper.get("nEstimators", 250)),
            max_depth=int(hyper.get("maxDepth", 6)),
            learning_rate=float(hyper.get("learningRate", 0.05)),
            subsample=float(hyper.get("subsample", 0.9)),
            colsample_bytree=float(hyper.get("colsampleBytree", 0.9)),
            objective="binary:logistic",
            eval_metric="logloss",
            n_jobs=threads,
            random_state=int(hyper.get("randomState", 42)),
        )
    elif kind == "lightgbm":
        if lgb is None:
            raise RuntimeError("LIGHTGBM_RUNTIME_UNAVAILABLE")
        model = lgb.LGBMClassifier(
            n_estimators=int(hyper.get("nEstimators", 250)),
            max_depth=int(hyper.get("maxDepth", -1)),
            learning_rate=float(hyper.get("learningRate", 0.05)),
            num_leaves=int(hyper.get("numLeaves", 31)),
            subsample=float(hyper.get("subsample", 0.9)),
            colsample_bytree=float(hyper.get("colsampleBytree", 0.9)),
            n_jobs=threads,
            random_state=int(hyper.get("randomState", 42)),
            verbosity=-1,
        )
    elif kind == "catboost":
        if cb is None:
            raise RuntimeError("CATBOOST_RUNTIME_UNAVAILABLE")
        model = cb.CatBoostClassifier(
            iterations=int(hyper.get("iterations", 250)),
            depth=int(hyper.get("depth", 6)),
            learning_rate=float(hyper.get("learningRate", 0.05)),
            loss_function="Logloss",
            verbose=False,
            thread_count=threads,
            random_seed=int(hyper.get("randomState", 42)),
        )
    else:
        raise ValueError(f"HORIZON_COHORT_UNSUPPORTED_MODEL:{kind}")
    model.fit(X, y)
    return model


def train_horizon_cohort(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    kind = native.validate_model_type(kind)
    if native.MODEL_SPECS[kind]["family"] != "tabular":
        raise ValueError("HORIZON_COHORT_REQUIRES_TABULAR_MODEL")
    schema = native.require_schema()
    symbol = str(payload.get("symbol") or "").strip()
    cohort_id = str(payload.get("cohortId") or "").strip()
    horizons = payload.get("horizons")
    if not symbol or not cohort_id or not isinstance(horizons, list) or len(horizons) < 2:
        raise ValueError("HORIZON_COHORT_METADATA_REQUIRED")

    train_sets = payload.get("trainDatasets")
    validation_sets = payload.get("validationDatasets")
    if not isinstance(train_sets, list) or not isinstance(validation_sets, list) or len(train_sets) != len(horizons) or len(validation_sets) != len(horizons):
        raise ValueError("HORIZON_COHORT_DATASET_ALIGNMENT_MISMATCH")

    train_vectors: list[list[float]] = []
    train_labels: list[int] = []
    validation_vectors: list[list[float]] = []
    validation_labels: list[int] = []
    horizon_counts: dict[str, dict[str, int]] = {}

    for horizon, train_payload, validation_payload in zip(horizons, train_sets, validation_sets):
        if not isinstance(horizon, dict):
            raise ValueError("INVALID_HORIZON_DESCRIPTOR")
        key = str(horizon.get("key") or "").strip()
        if not key:
            raise ValueError("INVALID_HORIZON_KEY")
        Xt, yt = _dataset(train_payload, "dataset")
        Xv, yv = _dataset(validation_payload, "dataset")
        if len(set(yt.tolist())) < 2 or len(set(yv.tolist())) < 2:
            raise ValueError(f"HORIZON_REQUIRES_TWO_CLASSES:{key}")
        train_vectors.extend(Xt.tolist())
        train_labels.extend(yt.tolist())
        validation_vectors.extend(Xv.tolist())
        validation_labels.extend(yv.tolist())
        horizon_counts[key] = {
            "train": int(len(Xt)),
            "validation": int(len(Xv)),
            "effectiveHorizonTicks": int(horizon.get("effectiveHorizonTicks")),
        }

    X_train = np.asarray(train_vectors, dtype=np.float32)
    y_train = np.asarray(train_labels, dtype=np.int64)
    X_validation = np.asarray(validation_vectors, dtype=np.float32)
    y_validation = np.asarray(validation_labels, dtype=np.int64)
    if len(X_train) < 2 or len(set(y_train.tolist())) < 2:
        raise ValueError("HORIZON_COHORT_TRAINING_DATA_INVALID")
    if len(X_validation) < 2 or len(set(y_validation.tolist())) < 2:
        raise ValueError("HORIZON_COHORT_VALIDATION_DATA_INVALID")

    raw_cpu = os.getenv("RENDER_CPU_COUNT", "1").strip()
    try:
        cpu_count = max(1, int(math.floor(float(raw_cpu))))
    except ValueError:
        cpu_count = max(1, int(os.cpu_count() or 1))
    threads = max(1, min(cpu_count, int(payload.get("threads") or cpu_count)))

    started = time.perf_counter()
    model = _fit(kind, X_train, y_train, payload.get("hyperparams") or {}, threads)
    fit_ms = round((time.perf_counter() - started) * 1000.0, 3)

    probabilities = model.predict_proba(X_validation)[:, 1]
    predictions = (probabilities >= 0.5).astype(np.int64)
    metrics = {
        "accuracy": round(float(accuracy_score(y_validation, predictions)) * 100.0, 3),
        "f1": round(float(f1_score(y_validation, predictions, zero_division=0)), 6),
        "logLoss": round(float(log_loss(y_validation, probabilities, labels=[0, 1])), 6),
    }

    safe_symbol = "".join(ch for ch in symbol if ch.isalnum() or ch in "_-")
    safe_cohort = "".join(ch for ch in cohort_id if ch.isalnum() or ch in "_-")
    path = MODEL_DIR / f"{safe_symbol}_cohort_{safe_cohort[:12]}_{kind}.pkl"
    record = {
        "modelType": kind,
        "model": model,
        "validation": metrics,
        "cohortId": cohort_id,
        "horizons": horizons,
        "horizonCounts": horizon_counts,
        "trainedOnceForCohort": True,
        "featureSource": "canonical-tick-properties",
        "trainedAt": time.time(),
        "trainingSamples": int(len(X_train)),
        "validationSamples": int(len(X_validation)),
        "fitMs": fit_ms,
    }
    native.validate_model_schema({
        **record,
        "schemaFingerprint": schema["schemaFingerprint"],
        "featureSchemaVersion": schema["featureSchemaVersion"],
        "featureCount": schema["featureCount"],
        "featureOrder": schema["featureOrder"],
        "sequenceLength": schema["sequenceLength"],
        "canonicalFeatureWindowTicks": schema["canonicalFeatureWindowTicks"],
    })
    record.update({
        "schemaFingerprint": schema["schemaFingerprint"],
        "featureSchemaVersion": schema["featureSchemaVersion"],
        "featureCount": schema["featureCount"],
        "featureOrder": list(schema["featureOrder"]),
        "sequenceLength": schema["sequenceLength"],
        "canonicalFeatureWindowTicks": schema["canonicalFeatureWindowTicks"],
    })
    temporary = Path(f"{path}.tmp")
    with temporary.open("wb") as handle:
        pickle.dump(record, handle, pickle.HIGHEST_PROTOCOL)
    temporary.replace(path)

    return {
        "success": True,
        "modelId": f"{safe_symbol}_cohort_{safe_cohort[:12]}_{kind}",
        "modelType": kind,
        "artifactPath": str(path),
        "cohortId": cohort_id,
        "horizons": horizons,
        "horizonCounts": horizon_counts,
        "metrics": metrics,
        "samplesCount": int(len(X_train)),
        "validationSamples": int(len(X_validation)),
        "trainedOnceForCohort": True,
        "fitMs": fit_ms,
    }
