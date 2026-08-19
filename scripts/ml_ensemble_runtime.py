"""Bounded parallel execution for the native ML production ensemble."""
from __future__ import annotations

import hashlib
import math
import os
import pickle
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

try:
    import numpy as np
except Exception:
    import pure_ml_engine as np

import ml_native_runtime as runtime
from ml_deep_models import predict as predict_deep


def _encode_horizon_condition(horizon: dict[str, Any]) -> list[float]:
    is_tick = 1.0 if str(horizon.get("unit", "")).lower() == "t" else 0.0
    val = float(horizon.get("value"))
    eff_ticks = float(horizon.get("effectiveHorizonTicks") or val)
    secs = float(horizon.get("seconds") or val)
    if not all(math.isfinite(v) and v > 0 for v in (val, eff_ticks, secs)):
        raise ValueError("HORIZON_CONDITION_INVALID")
    return [is_tick, math.log(val + 1.0), math.log(eff_ticks + 1.0), math.log(secs + 1.0)]


def _require_request_duration(request: dict[str, Any]) -> tuple[int, str]:
    raw_value = request.get("durationValue")
    raw_unit = request.get("durationUnit")
    if raw_value is None or raw_unit is None:
        raise ValueError("DURATION_METADATA_REQUIRED")
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        raise ValueError("DURATION_METADATA_REQUIRED") from None
    unit = str(raw_unit).strip().lower()
    if value <= 0 or unit not in {"t", "s", "m", "h", "d"}:
        raise ValueError("DURATION_METADATA_REQUIRED")
    return value, unit


def _parse_duration_seconds(key: str) -> float:
    clean = str(key).lower().strip()
    if len(clean) < 2:
        raise ValueError(f"INVALID_HORIZON_KEY:{key}")
    unit = clean[-1]
    try:
        value = float(clean[:-1])
    except ValueError:
        raise ValueError(f"INVALID_HORIZON_KEY:{key}") from None
    if not math.isfinite(value) or value <= 0 or unit not in {"t", "s", "m", "h", "d"}:
        raise ValueError(f"INVALID_HORIZON_KEY:{key}")
    return value if unit in {"t", "s"} else value * {"m": 60.0, "h": 3600.0, "d": 86400.0}[unit]


def _parse_horizon_key(key: str) -> tuple[int, str, float]:
    clean = str(key).lower().strip()
    if len(clean) < 2:
        raise ValueError(f"INVALID_HORIZON_KEY:{key}")
    unit = clean[-1]
    try:
        value = int(clean[:-1])
    except ValueError:
        raise ValueError(f"INVALID_HORIZON_KEY:{key}") from None
    if value <= 0 or unit not in {"t", "s", "m", "h", "d"}:
        raise ValueError(f"INVALID_HORIZON_KEY:{key}")
    return value, unit, _parse_duration_seconds(clean)


_ARTIFACT_CACHE: dict[str, dict[str, Any]] = {}


def _load_governed_artifact(production_model: dict[str, Any]) -> dict[str, Any]:
    artifact_path = str(production_model.get("artifactPath") or "").strip()
    expected_sha = str(production_model.get("artifactSha256") or "").strip().lower()
    if not artifact_path:
        raise ValueError("PROMOTED_MODEL_ARTIFACT_UNAVAILABLE")
    cache_key = f"{artifact_path}:{expected_sha}"
    if cache_key in _ARTIFACT_CACHE:
        return _ARTIFACT_CACHE[cache_key]
    path = Path(artifact_path)
    if not path.is_file():
        raise ValueError("PROMOTED_MODEL_ARTIFACT_UNAVAILABLE")
    raw = path.read_bytes()
    if expected_sha and hashlib.sha256(raw).hexdigest().lower() != expected_sha:
        raise ValueError("PROMOTED_MODEL_ARTIFACT_CHECKSUM_MISMATCH")
    record = pickle.loads(raw)
    if not isinstance(record, dict):
        raise ValueError("PROMOTED_MODEL_ARTIFACT_INVALID")
    _ARTIFACT_CACHE[cache_key] = record
    return record


def _predict_governed_one(request: dict[str, Any], model_type: str, production_model: dict[str, Any]) -> dict[str, Any]:
    try:
        record = _load_governed_artifact(production_model)
    except Exception as exc:
        return {"success": False, "id": request.get("id"), "modelType": model_type, "error": str(exc), "modelId": production_model.get("modelId"), "trainingRunId": production_model.get("trainingRunId"), "durationValue": production_model.get("durationValue"), "durationUnit": production_model.get("durationUnit")}

    schema = runtime.require_schema()
    dur_val, dur_unit = _require_request_duration(request)
    horizon_key = f"{dur_val}{dur_unit}"
    validation_meta = record.get("validation", {})

    is_multi_horizon = bool(record.get("trainedOnceForMultiHorizon") or production_model.get("strategyKey") == "unified_multi_horizon")
    if is_multi_horizon:
        h_metrics = validation_meta.get("horizonMetrics") if isinstance(validation_meta, dict) else None
        if not isinstance(h_metrics, dict) or not h_metrics:
            raise ValueError(f"AUTHORITATIVE_HORIZON_METRICS_UNAVAILABLE:{production_model.get('modelId')}")
        active_horizon_metric = h_metrics.get(horizon_key)
        if not isinstance(active_horizon_metric, dict):
            raise ValueError(f"AUTHORITATIVE_HORIZON_METRIC_MISSING:{production_model.get('modelId')}:{horizon_key}")
        validation_meta = {**validation_meta, **active_horizon_metric, "activeHorizonKey": horizon_key}

    metadata = {
        "validation": validation_meta,
        "schemaVersion": schema["featureSchemaVersion"],
        "schemaFingerprint": schema["schemaFingerprint"],
        "featureCount": schema["featureCount"],
        "trainedAt": record.get("trainedAt"),
        "modelId": production_model.get("modelId"),
        "trainingRunId": production_model.get("trainingRunId"),
        "durationValue": dur_val,
        "durationUnit": dur_unit,
        "artifactSha256": production_model.get("artifactSha256"),
        "governanceStatus": "production",
        "isMultiHorizon": is_multi_horizon,
        "horizonConditionKey": horizon_key if is_multi_horizon else None,
    }

    record_type = str(record.get("modelType") or "").strip().lower()
    req_type = str(model_type or "").strip().lower()
    is_tabular = req_type in {"xgboost", "lightgbm", "catboost"}
    is_sequential = req_type in {"tcn", "lstm", "transformer"}
    type_matches = (
        record_type == req_type
        or (record_type in {"tabular", "unified_multi_horizon", "unified_multi_horizon_tabular"} and is_tabular)
        or (record_type in {"sequential", "unified_multi_horizon_sequential"} and is_sequential)
        or (metadata["isMultiHorizon"] and is_tabular and "model" in record)
        or (metadata["isMultiHorizon"] and is_sequential and ("state_dict" in record or "model" in record))
    )
    if not type_matches:
        return {"success": False, "id": request.get("id"), "modelType": model_type, "error": "PRODUCTION_MODEL_TYPE_MISMATCH", **metadata}

    exact_fingerprint = record.get("schemaFingerprint") == schema["schemaFingerprint"]
    feat_count = record.get("featureCount")
    count_matches = feat_count == schema["featureCount"]
    order_matches = list(record.get("featureOrder", [])) == list(schema["featureOrder"])
    if not exact_fingerprint and not (count_matches and order_matches):
        return {"success": False, "id": request.get("id"), "modelType": model_type, "error": "MODEL_SCHEMA_MISMATCH:schemaFingerprint", **metadata}

    base_vector = runtime.validate_vector(request.get("featureVector"))
    if metadata["isMultiHorizon"]:
        h_token = _encode_horizon_condition({"unit": dur_unit, "value": dur_val, "seconds": request.get("durationSecs"), "effectiveHorizonTicks": request.get("effectiveHorizonTicks")})
        vector = np.asarray([list(base_vector) + h_token], dtype=np.float32)
    else:
        vector = np.asarray([base_vector], dtype=np.float32)

    if model_type in {"xgboost", "lightgbm", "catboost"}:
        model = record.get("model")
        if model is None:
            return {"success": False, "id": request.get("id"), "modelType": model_type, "error": "PREDICTIVE_ARTIFACT_MODEL_MISSING", **metadata}
        probabilities = model.predict_proba(vector)[0]
        down, up = float(probabilities[0]), float(probabilities[1])
        if not all(math.isfinite(v) and 0 <= v <= 1 for v in (up, down)):
            raise ValueError("MODEL_PROBABILITY_INVALID")
        engine_label = "Native Python trained unified multi-horizon artifact" if metadata["isMultiHorizon"] else "Native Python trained production artifact"
        return {**runtime.prediction_result(request, model_type, up, down), **metadata, "engine": engine_label}

    if model_type in {"tcn", "lstm", "transformer"}:
        if predict_deep is None:
            return {"success": False, "id": request.get("id"), "modelType": model_type, "error": "PYTORCH_SEQUENCE_RUNTIME_UNAVAILABLE", **metadata}
        sequence = request.get("featureSequence")
        if not isinstance(sequence, list) or len(sequence) != schema["sequenceLength"]:
            return {"success": False, "id": request.get("id"), "modelType": model_type, "error": "FEATURE_SEQUENCE_REQUIRED", **metadata}
        if metadata["isMultiHorizon"]:
            h_token = _encode_horizon_condition({"unit": dur_unit, "value": dur_val, "seconds": request.get("durationSecs"), "effectiveHorizonTicks": request.get("effectiveHorizonTicks")})
            conditioned_seq = [list(runtime.validate_vector(row)) + h_token for row in sequence]
            sequence_array = np.asarray([[row for row in conditioned_seq]], dtype=np.float32)
        else:
            sequence_array = np.asarray([[runtime.validate_vector(row) for row in sequence]], dtype=np.float32)
        state_dict = record.get("state_dict")
        if not isinstance(state_dict, dict):
            return {"success": False, "id": request.get("id"), "modelType": model_type, "error": "SEQUENCE_ARTIFACT_STATE_DICT_MISSING", **metadata}
        probabilities = predict_deep(model_type, state_dict, sequence_array)[0]
        up, down = float(probabilities[1]), float(probabilities[0])
        if not all(math.isfinite(v) and 0 <= v <= 1 for v in (up, down)):
            raise ValueError("MODEL_PROBABILITY_INVALID")
        engine_label = "Native Python trained unified multi-horizon artifact" if metadata["isMultiHorizon"] else "Native Python trained production artifact"
        return {**runtime.prediction_result(request, model_type, up, down), **metadata, "engine": engine_label}

    if model_type == "hmm":
        model = record.get("model")
        if model is None:
            return {"success": False, "id": request.get("id"), "modelType": model_type, "error": "REGIME_ARTIFACT_MODEL_MISSING", **metadata}
        probabilities = model.predict_proba(vector)[0]
        state = int(model.predict(vector)[0])
        return {"success": True, "id": request.get("id"), "modelType": model_type, "primaryRegime": f"REGIME_{state + 1}", "regimeState": state + 1, "regimeProbabilities": [round(float(value) * 100.0, 2) for value in probabilities], "engine": "Native Python trained production artifact", **metadata}

    if model_type == "isolation_forest":
        model = record.get("model")
        if model is None:
            return {"success": False, "id": request.get("id"), "modelType": model_type, "error": "ANOMALY_ARTIFACT_MODEL_MISSING", **metadata}
        raw = float(model.score_samples(vector)[0])
        if not math.isfinite(raw): raise ValueError("ANOMALY_SCORE_INVALID")
        return {"success": True, "id": request.get("id"), "modelType": model_type, "isAnomaly": int(model.predict(vector)[0]) == -1, "anomalyScore": max(0.0, min(1.0, 0.5 - raw)), "engine": "Native Python trained production artifact", **metadata}

    return {"success": False, "id": request.get("id"), "modelType": model_type, "error": f"UNSUPPORTED_MODEL:{model_type}", **metadata}


def _predict_one(request: dict[str, Any], model_type: str) -> tuple[str, dict[str, Any]]:
    try:
        production_models = request.get("productionModels")
        if not isinstance(production_models, dict) or not isinstance(production_models.get(model_type), dict):
            return model_type, {"success": False, "id": request.get("id"), "modelType": model_type, "error": "PRODUCTION_MODEL_RESOLUTION_REQUIRED"}
        return model_type, _predict_governed_one(request, model_type, production_models[model_type])
    except Exception as exc:
        return model_type, {"success": False, "id": request.get("id"), "modelType": model_type, "error": str(exc)}


def _aggregate_horizon_surface(request: dict[str, Any], model_types: list[str]) -> dict[str, dict[str, Any]]:
    production_models = request.get("productionModels")
    if not isinstance(production_models, dict): raise ValueError("PRODUCTION_MODEL_RESOLUTION_REQUIRED")
    keys: set[str] = set()
    for model in production_models.values():
        if not isinstance(model, dict): continue
        if not bool(model.get("isMultiHorizon")): continue
        metrics = model.get("validation")
        h_metrics = metrics.get("horizonMetrics") if isinstance(metrics, dict) else None
        if not isinstance(h_metrics, dict) or not h_metrics: continue
        keys.update(str(key) for key in h_metrics.keys())
    if not keys: raise ValueError("AUTHORITATIVE_HORIZON_METRICS_UNAVAILABLE")

    horizon_surface: dict[str, dict[str, Any]] = {}
    for key in sorted(keys, key=_parse_duration_seconds):
        value, unit, seconds = _parse_horizon_key(key)
        probe = dict(request)
        probe["durationValue"] = value
        probe["durationUnit"] = unit
        probe["durationSecs"] = seconds
        results = []
        for model_type in model_types:
            if model_type in {"hmm", "isolation_forest"}: continue
            _, result = _predict_one(probe, model_type)
            if result.get("success") is True and "probabilityUp" in result and "probabilityDown" in result:
                results.append((model_type, result))
        if not results:
            raise ValueError(f"AUTHORITATIVE_HORIZON_LIVE_PREDICTION_UNAVAILABLE:{key}")

        weighted_up = 0.0
        total_weight = 0.0
        for model_type, result in results:
            model = production_models.get(model_type)
            weight = float(model.get("qualityScore")) if isinstance(model, dict) else math.nan
            up = float(result.get("probabilityUp")); down = float(result.get("probabilityDown"))
            if not all(math.isfinite(v) and v >= 0 for v in (weight, up, down)) or weight <= 0:
                raise ValueError(f"AUTHORITATIVE_HORIZON_MODEL_WEIGHT_INVALID:{key}:{model_type}")
            weighted_up += up * weight
            total_weight += weight
        if total_weight <= 0: raise ValueError(f"AUTHORITATIVE_HORIZON_WEIGHT_UNAVAILABLE:{key}")
        probability_up = weighted_up / total_weight
        probability_down = 100.0 - probability_up
        confidence = max(probability_up, probability_down)
        direction = "RISE" if probability_up >= probability_down else "FALL"
        horizon_surface[key] = {
            "direction": direction,
            "probabilityUp": round(probability_up, 6),
            "probabilityDown": round(probability_down, 6),
            "confidence": round(confidence, 6),
        }
    return horizon_surface


def predict_ensemble(request: dict[str, Any]) -> dict[str, Any]:
    requested = request.get("modelTypes")
    model_types = [str(model_type) for model_type in requested] if isinstance(requested, list) else []
    if not model_types: return {"success": False, "id": request.get("id"), "models": {}, "error": "NO_PRODUCTION_MODELS_REQUESTED"}

    configured_workers = os.getenv("ML_ENSEMBLE_MAX_WORKERS", "3")
    try: worker_value = int(configured_workers)
    except ValueError: raise ValueError("ML_ENSEMBLE_MAX_WORKERS_INVALID") from None
    if worker_value <= 0: raise ValueError("ML_ENSEMBLE_MAX_WORKERS_INVALID")
    max_workers = min(worker_value, len(model_types))
    models: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="ml-ensemble") as executor:
        futures = {executor.submit(_predict_one, request, model_type): model_type for model_type in model_types}
        for future in as_completed(futures):
            model_type, result = future.result()
            models[model_type] = result

    horizon_surface = _aggregate_horizon_surface(request, model_types)
    return {"success": True, "id": request.get("id"), "models": {model_type: models[model_type] for model_type in model_types}, "horizons": horizon_surface, "execution": {"mode": "bounded_parallel", "workerCount": max_workers, "requestedModelCount": len(model_types), "governedProductionArtifacts": True}}
