"""Production ML daemon entrypoint.

Node/TypeScript owns feature calculation and production model governance.
Python owns only native model execution for the already-resolved artifact.
"""
from __future__ import annotations

import json
import sys
import time

import ml_native_runtime as runtime
import ml_duration_training_governed as duration_training
import ml_horizon_cohort_training as horizon_cohort_training
import ml_unified_horizon_training as unified_horizon_training
from ml_ensemble_runtime import predict_ensemble

ACTIONS = ("predict", "predict_ensemble", "train", "train_partitioned", "train_horizon_cohort", "train_unified_multi_horizon", "list_models", "ping", "backtest")


def _attach_runtime_timing(output: dict, elapsed_ms: float) -> dict:
    if not isinstance(output, dict): return output
    next_output = dict(output)
    elapsed = round(float(elapsed_ms), 3)
    metrics = next_output.get("metrics")
    if isinstance(metrics, dict):
        next_metrics = dict(metrics)
        timings = dict(next_metrics.get("timings") or {})
        timings["daemonDispatchMs"] = elapsed
        next_metrics["timings"] = timings
        next_output["metrics"] = next_metrics
        return next_output
    timings = dict(next_output.get("timings") or {})
    timings["daemonDispatchMs"] = elapsed
    next_output["timings"] = timings
    return next_output


def _attach_request_context(output: dict, request: dict) -> dict:
    if not isinstance(output, dict): return output
    next_output = dict(output)
    next_output.setdefault("id", request.get("id"))
    return next_output


def _expand_compact_sequence_dataset(dataset: object) -> None:
    if not isinstance(dataset, dict): return
    compact = dataset.get("featureSequences")
    if not isinstance(compact, dict): return
    feature_rows = compact.get("featureRows")
    labels = dataset.get("labels")
    sequence_length = dataset.get("sequenceLength")
    if not isinstance(feature_rows, list) or not isinstance(labels, list): raise ValueError("INVALID_COMPACT_SEQUENCE_DATASET")
    try: sequence_length_int = int(sequence_length)
    except (TypeError, ValueError): raise ValueError("INVALID_COMPACT_SEQUENCE_LENGTH")
    if sequence_length_int <= 0: raise ValueError("INVALID_COMPACT_SEQUENCE_LENGTH")
    expected_sequences = max(0, len(feature_rows) - sequence_length_int + 1)
    if expected_sequences != len(labels): raise ValueError(f"COMPACT_SEQUENCE_ALIGNMENT_MISMATCH: rows={len(feature_rows)} sequenceLength={sequence_length_int} labels={len(labels)}")
    dataset["featureSequences"] = [feature_rows[index:index + sequence_length_int] for index in range(expected_sequences)]


def _expand_compact_sequence_payload(request: dict) -> None:
    for key in ("trainSequenceDataset", "validationSequenceDataset"):
        dataset = request.get(key)
        if isinstance(dataset, dict): _expand_compact_sequence_dataset(dataset)


def dispatch(request: dict) -> dict:
    runtime.configure_schema(request.get("schemaContract"))
    action = request.get("action")
    if action == "predict": return runtime.predict_one(request)
    if action == "train": return runtime.train_one(request.get("modelType", "xgboost"), request)
    if action == "train_partitioned":
        _expand_compact_sequence_payload(request)
        return duration_training.train_partitioned(request.get("modelType", "xgboost"), request)
    if action == "train_horizon_cohort":
        return horizon_cohort_training.train_horizon_cohort(request.get("modelType", "xgboost"), request)
    if action == "train_unified_multi_horizon":
        return unified_horizon_training.train_unified_multi_horizon(request.get("modelType", "xgboost"), request)
    if action == "predict_ensemble": return predict_ensemble(request)
    if action == "backtest": return runtime.backtest(request)
    if action == "ping":
        schema = runtime.require_schema()
        return {"success": True, "id": request.get("id"), "pong": True, "schemaVersion": schema["featureSchemaVersion"], "schemaFingerprint": schema["schemaFingerprint"], "featureCount": schema["featureCount"], "models": runtime.model_types()}
    if action == "list_models":
        schema = runtime.require_schema()
        return {"success": True, "id": request.get("id"), "schemaFingerprint": schema["schemaFingerprint"], "models": [path.name for path in runtime.MODEL_DIR.glob("*.pkl")], "supportedModelTypes": runtime.model_types(), "note": "Local listing is diagnostic only; production inference is registry-governed."}
    return {"success": False, "id": request.get("id"), "error": f"Unknown action {action}"}


def main() -> None:
    sys.stdout.write(json.dumps({"type": "ready", "schemaContractRequired": True, "featureSource": "node-canonical-registry", "modelSource": "native-python-runtime", "actions": list(ACTIONS), "models": runtime.model_types()}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        request: dict = {}
        started = time.perf_counter()
        output: dict = {"success": False, "error": "UNINITIALIZED_RUNTIME_RESULT"}
        try:
            request = json.loads(line)
            output = _attach_request_context(dispatch(request), request)
        except Exception as exc:
            output = {"success": False, "id": request.get("id") if isinstance(request, dict) else None, "error": str(exc)}
        finally:
            output = _attach_runtime_timing(output, (time.perf_counter() - started) * 1000.0)
        sys.stdout.write(json.dumps(output, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
