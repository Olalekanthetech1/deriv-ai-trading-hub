"""Native Hybrid Horizon-Conditioned Multi-Horizon Model Training Runtime.

Fits a single unified model once across all horizons (both tick-based and time-based)
using pure tick-microstructure feature properties with horizon conditioning embeddings.
Computes comprehensive per-horizon validation matrices (Accuracy, F1, LogLoss, WinRate,
ROC-AUC, and Brier score) required for governed production selection.
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
    from sklearn.metrics import accuracy_score, brier_score_loss, f1_score, log_loss, roc_auc_score
except Exception:
    import pure_ml_engine as _pure
    accuracy_score = _pure.accuracy_score
    brier_score_loss = _pure.brier_score_loss
    f1_score = _pure.f1_score
    log_loss = _pure.log_loss
    roc_auc_score = _pure.roc_auc_score

MODEL_DIR = Path(os.getenv("MODEL_CACHE_DIR", str(Path(__file__).resolve().parent.parent / "models_cache")))
MODEL_DIR.mkdir(parents=True, exist_ok=True)


def _encode_horizon_condition(horizon: dict[str, Any]) -> list[float]:
    """Encodes duration attributes into a normalized 4-element conditioning token.

    [is_tick (1.0 or 0.0), log(duration_val), log(effective_ticks), log(seconds_or_ticks)]
    """
    is_tick = 1.0 if str(horizon.get("unit", "")).lower() == "t" else 0.0
    val = max(1.0, float(horizon.get("value", 1)))
    eff_ticks = max(1.0, float(horizon.get("effectiveHorizonTicks") or val))
    secs = float(horizon.get("seconds") or val)
    return [
        is_tick,
        math.log(val + 1.0),
        math.log(eff_ticks + 1.0),
        math.log(secs + 1.0),
    ]


def _build_conditioned_dataset(
    samples: list[dict[str, Any]],
    horizons: list[dict[str, Any]],
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Transforms multi-horizon target samples into a conditioned training matrix."""
    schema = native.require_schema()
    base_dim = schema["featureCount"]

    X_list: list[list[float]] = []
    y_list: list[int] = []
    horizon_keys: list[str] = []

    for sample in samples:
        raw_vector = sample.get("featureVector")
        if not isinstance(raw_vector, list) or len(raw_vector) != base_dim:
            continue
        labels_map = sample.get("horizonLabels") or {}
        if not isinstance(labels_map, dict):
            continue

        for h in horizons:
            key = str(h.get("key", "")).lower()
            if not key or key not in labels_map:
                continue
            label_val = labels_map[key]
            if label_val not in ("RISE", "FALL", 1, 0):
                continue
            target_bin = 1 if label_val in ("RISE", 1) else 0

            h_token = _encode_horizon_condition(h)
            conditioned_row = list(raw_vector) + h_token

            X_list.append(conditioned_row)
            y_list.append(target_bin)
            horizon_keys.append(key)

    if not X_list:
        raise ValueError("NO_VALID_CONDITIONED_SAMPLES_CONSTRUCTED")

    return np.asarray(X_list, dtype=np.float32), np.asarray(y_list, dtype=np.int64), horizon_keys


def _fit_model(kind: str, X: np.ndarray, y: np.ndarray, hyper: dict[str, Any], threads: int):
    pos_count = int(np.sum(y == 1))
    neg_count = int(np.sum(y == 0))
    scale_pos_weight = float(neg_count / max(1, pos_count))

    if kind == "xgboost":
        if xgb is None:
            import pure_ml_engine as _pure
            model = _pure.PureGBDTClassifier(
                max_depth=min(3, int(hyper.get("maxDepth", 6))),
                learning_rate=float(hyper.get("learningRate", 0.04)),
                n_estimators=min(15, int(hyper.get("nEstimators", 300))),
                subsample=float(hyper.get("subsample", 0.85)),
            )
        else:
            model = xgb.XGBClassifier(
                n_estimators=int(hyper.get("nEstimators", 300)),
                max_depth=int(hyper.get("maxDepth", 6)),
                learning_rate=float(hyper.get("learningRate", 0.04)),
                subsample=float(hyper.get("subsample", 0.85)),
                colsample_bytree=float(hyper.get("colsampleBytree", 0.85)),
                scale_pos_weight=scale_pos_weight,
                objective="binary:logistic",
                eval_metric="logloss",
                n_jobs=threads,
                random_state=int(hyper.get("randomState", 42)),
            )
    elif kind == "lightgbm":
        if lgb is None:
            import pure_ml_engine as _pure
            model = _pure.PureGBDTClassifier(
                max_depth=min(3, int(hyper.get("maxDepth", 6))),
                learning_rate=float(hyper.get("learningRate", 0.04)),
                n_estimators=min(15, int(hyper.get("nEstimators", 300))),
                subsample=float(hyper.get("subsample", 0.85)),
            )
        else:
            model = lgb.LGBMClassifier(
                n_estimators=int(hyper.get("nEstimators", 300)),
                max_depth=int(hyper.get("maxDepth", -1)),
                learning_rate=float(hyper.get("learningRate", 0.04)),
                num_leaves=int(hyper.get("numLeaves", 31)),
                subsample=float(hyper.get("subsample", 0.85)),
                colsample_bytree=float(hyper.get("colsampleBytree", 0.85)),
                scale_pos_weight=scale_pos_weight,
                n_jobs=threads,
                random_state=int(hyper.get("randomState", 42)),
                verbosity=-1,
            )
    elif kind == "catboost":
        if cb is None:
            import pure_ml_engine as _pure
            model = _pure.PureGBDTClassifier(
                max_depth=min(3, int(hyper.get("depth", 6))),
                learning_rate=float(hyper.get("learningRate", 0.04)),
                n_estimators=min(15, int(hyper.get("iterations", 300))),
                subsample=1.0,
            )
        else:
            model = cb.CatBoostClassifier(
                iterations=int(hyper.get("iterations", 300)),
                depth=int(hyper.get("depth", 6)),
                learning_rate=float(hyper.get("learningRate", 0.04)),
                scale_pos_weight=scale_pos_weight,
                loss_function="Logloss",
                verbose=False,
                thread_count=threads,
                random_seed=int(hyper.get("randomState", 42)),
            )
    elif kind == "hmm":
        if native.GaussianHMM is None:
            raise RuntimeError("HMMLEARN_RUNTIME_UNAVAILABLE")
        model = native.GaussianHMM(
            n_components=int(hyper.get("components", 3)),
            covariance_type="diag",
            n_iter=int(hyper.get("iterations", 100)),
            random_state=int(hyper.get("randomState", 42)),
        )
        model.fit(X)
        return model
    elif kind == "isolation_forest":
        if native.IsolationForest is None:
            raise RuntimeError("SCIKIT_LEARN_RUNTIME_UNAVAILABLE")
        model = native.IsolationForest(
            n_estimators=int(hyper.get("numEstimators", 150)),
            contamination="auto",
            random_state=int(hyper.get("randomState", 42)),
            n_jobs=threads,
        )
        model.fit(X)
        return model
    else:
        raise ValueError(f"UNSUPPORTED_UNIFIED_MODEL_KIND:{kind}")

    model.fit(X, y)
    return model


def _validate_binary_metric(value: float, name: str) -> float:
    numeric = float(value)
    if not math.isfinite(numeric) or numeric < 0.0 or numeric > 1.0:
        raise ValueError(f"UNIFIED_VALIDATION_METRIC_INVALID:{name}")
    return numeric


def train_unified_multi_horizon(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Fits one unified horizon-conditioned model across all horizons and evaluates per-horizon metrics."""
    kind = native.validate_model_type(kind)
    schema = native.require_schema()

    symbol = str(payload.get("symbol") or "").strip().upper()
    dataset_id = str(payload.get("datasetId") or "").strip()
    horizons = payload.get("horizons")
    train_samples = payload.get("trainSamples")
    val_samples = payload.get("validationSamples")

    if not symbol or not dataset_id or not isinstance(horizons, list) or len(horizons) < 1:
        raise ValueError("UNIFIED_TRAINING_METADATA_REQUIRED")
    if not isinstance(train_samples, list) or not isinstance(val_samples, list) or not train_samples or not val_samples:
        raise ValueError("UNIFIED_TRAINING_DATASETS_REQUIRED")

    X_train, y_train, _ = _build_conditioned_dataset(train_samples, horizons)
    X_val, y_val, val_horizon_keys = _build_conditioned_dataset(val_samples, horizons)

    if len(set(y_train.tolist())) < 2 or len(set(y_val.tolist())) < 2:
        raise ValueError("INSUFFICIENT_TWO_CLASS_UNIFIED_DATA")

    raw_cpu = os.getenv("RENDER_CPU_COUNT", "1").strip()
    try:
        cpu_count = max(1, int(math.floor(float(raw_cpu))))
    except ValueError:
        cpu_count = max(1, int(os.cpu_count() or 1))
    threads = max(1, min(cpu_count, int(payload.get("threads") or cpu_count)))

    started = time.perf_counter()
    model = _fit_model(kind, X_train, y_train, payload.get("hyperparams") or {}, threads)
    fit_ms = round((time.perf_counter() - started) * 1000.0, 3)

    # Predict on validation set
    probabilities = model.predict_proba(X_val)[:, 1]
    predictions = (probabilities >= 0.5).astype(np.int64)

    overall_acc = round(float(accuracy_score(y_val, predictions)) * 100.0, 3) if accuracy_score else 0.0
    overall_f1 = round(float(f1_score(y_val, predictions, zero_division=0)), 6) if f1_score else 0.0
    overall_loss = round(float(log_loss(y_val, probabilities, labels=[0, 1])), 6) if log_loss else 0.0

    # Compute per-horizon metrics breakdown. Every production horizon must have both
    # classes and authoritative probability metrics; otherwise it is not promotable.
    val_horizon_arr = np.asarray(val_horizon_keys)
    horizon_metrics: dict[str, Any] = {}

    for h in horizons:
        h_key = str(h.get("key", "")).lower()
        mask = val_horizon_arr == h_key
        if np.sum(mask) == 0:
            raise ValueError(f"UNIFIED_HORIZON_VALIDATION_DATA_MISSING:{h_key}")
        h_y = y_val[mask]
        h_preds = predictions[mask]
        h_probs = probabilities[mask]

        if len(set(h_y.tolist())) < 2:
            raise ValueError(f"UNIFIED_HORIZON_VALIDATION_SINGLE_CLASS:{h_key}")
        if accuracy_score is None or f1_score is None or log_loss is None or roc_auc_score is None or brier_score_loss is None:
            raise RuntimeError("SKLEARN_VALIDATION_METRICS_RUNTIME_UNAVAILABLE")

        acc = round(float(accuracy_score(h_y, h_preds)) * 100.0, 3)
        f1 = round(float(f1_score(h_y, h_preds, zero_division=0)), 6)
        loss = round(float(log_loss(h_y, h_probs, labels=[0, 1])), 6)
        auc = round(_validate_binary_metric(roc_auc_score(h_y, h_probs), "auc"), 6)
        brier = round(_validate_binary_metric(brier_score_loss(h_y, h_probs), "brierScore"), 6)
        win_rate = round(acc, 3)  # Binary directional win rate matches validation accuracy.

        horizon_metrics[h_key] = {
            "horizonKey": h_key,
            "horizonType": h.get("type", "tick"),
            "durationValue": int(h.get("value", 1)),
            "durationUnit": str(h.get("unit", "t")),
            "samples": int(np.sum(mask)),
            "accuracy": acc,
            "f1": f1,
            "logLoss": loss,
            "winRate": win_rate,
            "auc": auc,
            "brierScore": brier,
        }

    safe_symbol = "".join(ch for ch in symbol if ch.isalnum() or ch in "_-")
    model_id = f"{safe_symbol}_unified_multi_horizon_{kind}"
    artifact_path = MODEL_DIR / f"{model_id}.pkl"

    record = {
        "modelId": model_id,
        "modelType": kind,
        "model": model,
        "symbol": symbol,
        "datasetId": dataset_id,
        "horizons": horizons,
        "trainedOnceForMultiHorizon": True,
        "featureSource": "canonical-tick-microstructure-only",
        "validation": {
            "overallAccuracy": overall_acc,
            "overallF1": overall_f1,
            "overallLogLoss": overall_loss,
            "horizonMetrics": horizon_metrics,
        },
        "trainedAt": time.time(),
        "trainingSamples": int(len(X_train)),
        "validationSamples": int(len(X_val)),
        "fitMs": fit_ms,
        "schemaFingerprint": schema["schemaFingerprint"],
        "featureSchemaVersion": schema["featureSchemaVersion"],
        "featureCount": schema["featureCount"],
        "featureOrder": list(schema["featureOrder"]),
    }

    temporary = Path(f"{artifact_path}.tmp")
    with temporary.open("wb") as handle:
        pickle.dump(record, handle, pickle.HIGHEST_PROTOCOL)
    temporary.replace(artifact_path)

    return {
        "success": True,
        "modelId": model_id,
        "modelType": kind,
        "symbol": symbol,
        "artifactPath": str(artifact_path),
        "datasetId": dataset_id,
        "trainingSamples": int(len(X_train)),
        "validationSamples": int(len(X_val)),
        "overallAccuracy": overall_acc,
        "overallLogLoss": overall_loss,
        "overallF1": overall_f1,
        "horizonMetrics": horizon_metrics,
        "fitMs": fit_ms,
        "trainedOnceForMultiHorizon": True,
        "featureSchemaVersion": schema["featureSchemaVersion"],
        "engine": f"Trained native unified multi-horizon {kind} (1 model for all horizons)",
    }
