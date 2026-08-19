"""Partition-aware native training for duration-specific persisted datasets."""
from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

try:
    import numpy as np
except Exception:
    import pure_ml_engine as np

import ml_native_runtime as native
from ml_duration_artifacts import save_duration

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
    from sklearn.ensemble import IsolationForest
    from sklearn.metrics import accuracy_score, log_loss
except Exception:
    import pure_ml_engine as _pure
    IsolationForest = _pure.PureIsolationForest
    accuracy_score = _pure.accuracy_score
    log_loss = _pure.log_loss

try:
    from hmmlearn.hmm import GaussianHMM
except Exception:
    import pure_ml_engine as _pure
    GaussianHMM = _pure.PureGaussianHMM

try:
    from ml_deep_models import train as train_deep, predict as predict_deep
except Exception:
    train_deep = None
    predict_deep = None


def _runtime_resource_budget() -> dict[str, int]:
    """Derive a conservative per-training CPU budget from the deployment runtime."""
    raw_cpu = os.getenv("RENDER_CPU_COUNT", "").strip()
    try:
        cpu_count = float(raw_cpu) if raw_cpu else float(os.cpu_count() or 1)
    except ValueError:
        cpu_count = float(os.cpu_count() or 1)
    cpu_count = max(0.25, cpu_count)

    raw_concurrency = os.getenv("ML_TRAINING_CONCURRENCY", "1").strip()
    try:
        concurrency = int(raw_concurrency)
    except ValueError:
        concurrency = 1
    concurrency = max(1, min(concurrency, 16))

    thread_budget = max(1, int(math.floor(cpu_count / concurrency)))
    return {
        "cpuCountMilli": int(round(cpu_count * 1000)),
        "trainingConcurrency": concurrency,
        "threadBudget": thread_budget,
    }


def _bounded_threads(requested: Any, budget: int) -> int:
    try:
        requested_int = int(requested)
    except (TypeError, ValueError):
        requested_int = budget
    return max(1, min(requested_int, budget))


def _elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000.0, 3)


def _emit_progress(request: dict[str, Any], phase: str, total_started: float, timings: dict[str, float], message: str | None = None, extra: dict[str, Any] | None = None) -> None:
    """Emit machine-readable progress over the daemon stdout protocol."""
    event: dict[str, Any] = {
        "type": "progress",
        "id": request.get("id"),
        "trainingRunId": request.get("trainingRunId"),
        "modelType": request.get("modelType"),
        "phase": phase,
        "elapsedMs": _elapsed_ms(total_started),
        "timings": dict(timings),
    }
    if message:
        event["message"] = message
    if extra:
        event.update(extra)
    try:
        sys.stdout.write(json.dumps(event, default=str) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def _partition(payload: dict[str, Any], key: str, sequence: bool = False):
    data = payload.get(key)
    if not isinstance(data, dict):
        raise ValueError(f"{key.upper()}_REQUIRED")

    vectors = data.get("featureSequences" if sequence else "featureVectors")
    labels = data.get("labels")
    if not isinstance(vectors, list) or not isinstance(labels, list) or len(vectors) != len(labels) or not vectors:
        raise ValueError(f"INVALID_{key.upper()}")

    schema = native.require_schema()
    if int(data.get("featureCount", -1)) != schema["featureCount"]:
        raise ValueError("FEATURE_DATASET_SCHEMA_MISMATCH")
    if data.get("schemaFingerprint") != schema["schemaFingerprint"]:
        raise ValueError("FEATURE_DATASET_FINGERPRINT_MISMATCH")
    if sequence and int(data.get("sequenceLength", -1)) != schema["sequenceLength"]:
        raise ValueError("SEQUENCE_DATASET_SEQUENCE_LENGTH_MISMATCH")

    if sequence:
        X = np.asarray([[[float(x) for x in row] for row in seq] for seq in vectors], dtype=np.float32)
    else:
        X = np.asarray([native.validate_vector(vec) for vec in vectors], dtype=np.float32)

    y = np.asarray([int(v) for v in labels], dtype=np.int64)
    return X, y


def _require_two_classes(y: np.ndarray, name: str):
    if len(y) < 2 or len(set(y.tolist())) < 2:
        raise ValueError(f"{name}_LABELS_SINGLE_CLASS")


def train_partitioned(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    kind = native.validate_model_type(kind)
    schema = native.require_schema()
    symbol = str(payload.get("symbol") or "").strip()
    duration_key = int(payload.get("effectiveHorizonTicks"))
    duration_value = payload.get("durationValue")
    duration_unit = str(payload.get("durationUnit") or "")
    duration_seconds = payload.get("durationSeconds")
    training_run_id = payload.get("trainingRunId")
    resource_budget = _runtime_resource_budget()
    thread_budget = resource_budget["threadBudget"]

    if not symbol:
        raise ValueError("SYMBOL_REQUIRED")
    if not isinstance(duration_key, int) or duration_key <= 0:
        raise ValueError("EFFECTIVE_HORIZON_TICKS_REQUIRED")
    if not isinstance(duration_value, int) or duration_value <= 0 or duration_unit not in {"t", "s", "m", "h", "d"}:
        raise ValueError("DURATION_METADATA_REQUIRED")

    hyper = payload.get("hyperparams") or {}
    family = native.MODEL_SPECS[kind]["family"]
    timings: dict[str, float] = {
        "trainPartitionMs": 0.0,
        "validationPartitionMs": 0.0,
        "fitMs": 0.0,
        "predictionMs": 0.0,
        "artifactSaveMs": 0.0,
        "totalMs": 0.0,
    }

    total_started = time.perf_counter()
    _emit_progress(payload, "starting", total_started, timings, "Native training request accepted.")
    if family == "sequential":
        train_partition_started = time.perf_counter()
        Xt, yt = _partition(payload, "trainSequenceDataset", True)
        timings["trainPartitionMs"] = _elapsed_ms(train_partition_started)
        _emit_progress(payload, "train_partition_validated", total_started, timings, f"Training partition validated: {len(Xt)} sequences.")

        validation_partition_started = time.perf_counter()
        Xv, yv = _partition(payload, "validationSequenceDataset", True)
        timings["validationPartitionMs"] = _elapsed_ms(validation_partition_started)
        _emit_progress(payload, "validation_partition_validated", total_started, timings, f"Validation partition validated: {len(Xv)} sequences.")
    else:
        train_partition_started = time.perf_counter()
        Xt, yt = _partition(payload, "trainTabularDataset")
        timings["trainPartitionMs"] = _elapsed_ms(train_partition_started)
        _emit_progress(payload, "train_partition_validated", total_started, timings, f"Training partition validated: {len(Xt)} rows.")

        validation_partition_started = time.perf_counter()
        Xv, yv = _partition(payload, "validationTabularDataset")
        timings["validationPartitionMs"] = _elapsed_ms(validation_partition_started)
        _emit_progress(payload, "validation_partition_validated", total_started, timings, f"Validation partition validated: {len(Xv)} rows.")

    _require_two_classes(yt, "TRAINING")
    _require_two_classes(yv, "VALIDATION")
    metrics: dict[str, Any] = {}
    _emit_progress(payload, "model_fit_start", total_started, timings, f"Starting native {kind} model fit.")

    if family == "sequential":
        fit_started = time.perf_counter()
        last_deep_progress: dict[str, Any] = {}

        def deep_progress(event: dict[str, Any]) -> None:
            nonlocal last_deep_progress
            last_deep_progress = dict(event)
            phase = str(event.get("phase") or "deep_training_progress")
            deep_timings = dict(timings)
            if event.get("epochMs") is not None:
                deep_timings["lastEpochMs"] = float(event["epochMs"])
            if event.get("trainingMs") is not None:
                deep_timings["deepTrainingMs"] = float(event["trainingMs"])
            _emit_progress(
                payload,
                phase,
                total_started,
                deep_timings,
                f"{kind} native progress: {phase}.",
                {"deepTraining": event},
            )

        model = train_deep(
            kind,
            Xt,
            yt,
            epochs=int(hyper.get("epochs", 8)),
            batch_size=int(hyper.get("batchSize", 64)),
            lr=float(hyper.get("learningRate", 0.001)),
            progress=deep_progress,
        )
        timings["fitMs"] = _elapsed_ms(fit_started)
        if last_deep_progress.get("peakRssBytes") is not None:
            timings["peakRssBytes"] = float(last_deep_progress["peakRssBytes"])
        if last_deep_progress.get("deepTrainingMs") is not None:
            timings["deepTrainingMs"] = float(last_deep_progress["deepTrainingMs"])
        if last_deep_progress.get("epochsCompleted") is not None:
            timings["epochsCompleted"] = float(last_deep_progress["epochsCompleted"])
        _emit_progress(payload, "model_fit_complete", total_started, timings, f"Native {kind} fit completed in {timings['fitMs']:.1f} ms.")

        predict_started = time.perf_counter()
        state = getattr(model, "state_dict", lambda: {})()
        if hasattr(state, "items"):
            state = {k: getattr(v, "cpu", lambda: v)() for k, v in state.items()}
        probabilities = predict_deep(kind, state, Xv)
        predictions = np.argmax(probabilities, axis=1)
        timings["predictionMs"] = _elapsed_ms(predict_started)

        metrics = {
            "accuracy": round(float(accuracy_score(yv, predictions)) * 100, 3),
            "logLoss": round(float(log_loss(yv, probabilities, labels=[0, 1])), 6),
        }
        _emit_progress(payload, "prediction_complete", total_started, timings, f"Validation prediction completed in {timings['predictionMs']:.1f} ms.")
        record = {
            "modelType": kind,
            "state_dict": state,
            "validation": metrics,
            "timings": dict(timings),
            "trainedAt": time.time(),
        }
        engine = f"Trained native PyTorch/Pure {kind} from persisted duration partition"
    else:
        if kind == "xgboost":
            if xgb is None:
                import pure_ml_engine as _pure
                fit_started = time.perf_counter()
                model = _pure.PureGBDTClassifier(
                    max_depth=int(hyper.get("maxDepth", 6)),
                    learning_rate=float(hyper.get("learningRate", 0.05)),
                    n_estimators=int(hyper.get("numEstimators", 100)),
                    subsample=float(hyper.get("subsample", 0.8)),
                ).fit(Xt, yt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native Pure-Python XGBoost from persisted duration partition"
            else:
                fit_started = time.perf_counter()
                model = xgb.XGBClassifier(
                    max_depth=int(hyper.get("maxDepth", 6)),
                    learning_rate=float(hyper.get("learningRate", 0.05)),
                    n_estimators=int(hyper.get("numEstimators", 100)),
                    subsample=float(hyper.get("subsample", 0.8)),
                    eval_metric="logloss",
                    n_jobs=_bounded_threads(hyper.get("nJobs", thread_budget), thread_budget),
                ).fit(Xt, yt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native Python XGBoost from persisted duration partition"
        elif kind == "lightgbm":
            if lgb is None:
                import pure_ml_engine as _pure
                fit_started = time.perf_counter()
                model = _pure.PureGBDTClassifier(
                    n_estimators=int(hyper.get("numEstimators", 100)),
                    learning_rate=float(hyper.get("learningRate", 0.05)),
                    max_depth=int(hyper.get("maxDepth", 4)),
                ).fit(Xt, yt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native Pure-Python LightGBM from persisted duration partition"
            else:
                fit_started = time.perf_counter()
                model = lgb.LGBMClassifier(
                    n_estimators=int(hyper.get("numEstimators", 100)),
                    learning_rate=float(hyper.get("learningRate", 0.05)),
                    num_leaves=int(hyper.get("numLeaves", 31)),
                    random_state=int(hyper.get("randomState", 42)),
                    verbosity=-1,
                    n_jobs=_bounded_threads(hyper.get("nJobs", thread_budget), thread_budget),
                ).fit(Xt, yt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native Python LightGBM from persisted duration partition"
        elif kind == "catboost":
            if cb is None:
                import pure_ml_engine as _pure
                fit_started = time.perf_counter()
                model = _pure.PureGBDTClassifier(
                    iterations=int(hyper.get("numEstimators", 100)),
                    depth=int(hyper.get("maxDepth", 6)),
                    learning_rate=float(hyper.get("learningRate", 0.05)),
                ).fit(Xt, yt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native Pure-Python CatBoost from persisted duration partition"
            else:
                fit_started = time.perf_counter()
                model = cb.CatBoostClassifier(
                    iterations=int(hyper.get("numEstimators", 100)),
                    depth=int(hyper.get("maxDepth", 6)),
                    learning_rate=float(hyper.get("learningRate", 0.05)),
                    verbose=False,
                    random_seed=int(hyper.get("randomState", 42)),
                    thread_count=_bounded_threads(hyper.get("threadCount", thread_budget), thread_budget),
                ).fit(Xt, yt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native Python CatBoost from persisted duration partition"
        elif kind == "hmm":
            if GaussianHMM is None or not hasattr(GaussianHMM, "fit"):
                import pure_ml_engine as _pure
                fit_started = time.perf_counter()
                model = _pure.PureGaussianHMM(
                    n_components=int(hyper.get("components", 4)),
                ).fit(Xt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native Pure-Python GaussianHMM from persisted duration partition"
            else:
                fit_started = time.perf_counter()
                model = GaussianHMM(
                    n_components=int(hyper.get("components", 4)),
                    covariance_type="diag",
                    n_iter=int(hyper.get("iterations", 100)),
                    random_state=int(hyper.get("randomState", 42)),
                ).fit(Xt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native hmmlearn GaussianHMM from persisted duration partition"
        elif kind == "isolation_forest":
            if IsolationForest is None or not hasattr(IsolationForest, "fit"):
                import pure_ml_engine as _pure
                fit_started = time.perf_counter()
                model = _pure.PureIsolationForest(
                    n_estimators=int(hyper.get("numEstimators", 200)),
                ).fit(Xt, yt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native Pure-Python IsolationForest from persisted duration partition"
            else:
                fit_started = time.perf_counter()
                model = IsolationForest(
                    n_estimators=int(hyper.get("numEstimators", 200)),
                    contamination="auto",
                    random_state=int(hyper.get("randomState", 42)),
                    n_jobs=_bounded_threads(hyper.get("nJobs", thread_budget), thread_budget),
                ).fit(Xt, yt)
                timings["fitMs"] = _elapsed_ms(fit_started)
                engine = "Trained native scikit-learn IsolationForest from persisted duration partition"
        else:
            raise ValueError(f"UNSUPPORTED_TABULAR_MODEL:{kind}")

        _emit_progress(payload, "model_fit_complete", total_started, timings, f"Native {kind} fit completed in {timings['fitMs']:.1f} ms.")
        if kind in {"xgboost", "lightgbm", "catboost"}:
            prediction_started = time.perf_counter()
            probabilities = model.predict_proba(Xv)
            predictions = np.argmax(probabilities, axis=1)
            timings["predictionMs"] = _elapsed_ms(prediction_started)
            metrics = {
                "accuracy": round(float(accuracy_score(yv, predictions)) * 100, 3),
                "logLoss": round(float(log_loss(yv, probabilities, labels=[0, 1])), 6),
            }
            _emit_progress(payload, "prediction_complete", total_started, timings, f"Validation prediction completed in {timings['predictionMs']:.1f} ms.")
        else:
            metrics = {}

        record = {
            "modelType": kind,
            "model": model,
            "validation": metrics,
            "timings": dict(timings),
            "trainedAt": time.time(),
        }

    _emit_progress(payload, "artifact_save_start", total_started, timings, "Persisting candidate model artifact.")
    artifact_started = time.perf_counter()
    artifact = save_duration(kind, symbol, duration_value, duration_unit, record, str(training_run_id) if training_run_id else None)
    timings["artifactSaveMs"] = _elapsed_ms(artifact_started)
    timings["totalMs"] = _elapsed_ms(total_started)
    _emit_progress(payload, "artifact_save_complete", total_started, timings, f"Artifact persisted in {timings['artifactSaveMs']:.1f} ms.")

    metrics = dict(metrics)
    metrics["timings"] = dict(timings)
    metrics["resourceBudget"] = resource_budget

    lineage = str(training_run_id)[:12] if training_run_id else "legacy"
    model_id = f"{symbol}_{duration_unit}{duration_value}_{kind}_{lineage}"
    return {
        "success": True,
        "modelId": model_id,
        "modelType": kind,
        "artifactPath": str(artifact),
        "effectiveHorizonTicks": duration_key,
        "durationValue": duration_value,
        "durationUnit": duration_unit,
        "durationSeconds": duration_seconds,
        "samplesCount": int(len(Xt)),
        "validationSamples": int(len(Xv)),
        "featureCount": schema["featureCount"],
        "sequenceLength": schema["sequenceLength"],
        "metrics": metrics,
        "timings": dict(timings),
        "resourceBudget": resource_budget,
        "accuracy": metrics.get("accuracy"),
        "schemaVersion": schema["featureSchemaVersion"],
        "schemaFingerprint": schema["schemaFingerprint"],
        "engine": engine,
    }
