"""Duration-aware native artifact validation and persistence."""
from __future__ import annotations

import os
import pickle
from pathlib import Path
from typing import Any

import ml_native_runtime as native

MODEL_DIR = Path(os.getenv("MODEL_CACHE_DIR", str(Path(__file__).resolve().parent.parent / "models_cache")))
MODEL_DIR.mkdir(parents=True, exist_ok=True)


def _safe(value: str) -> str:
    cleaned = "".join(ch for ch in str(value) if ch.isalnum() or ch in "_-.")
    if not cleaned:
        raise ValueError("INVALID_ARTIFACT_ID")
    return cleaned


def model_path(kind: str, symbol: str, duration_value: int, duration_unit: str, training_run_id: str | None = None) -> Path:
    lineage = f"_{_safe(training_run_id)[:12]}" if training_run_id else ""
    return MODEL_DIR / f"{_safe(symbol)}_{_safe(duration_unit)}{int(duration_value)}_{_safe(kind)}{lineage}.pkl"


def load_record_from_path(path: str | Path, kind: str, duration_value: int, duration_unit: str, training_run_id: str | None = None) -> Any | None:
    candidate = Path(path)
    if not candidate.exists() or not candidate.is_file():
        return None
    try:
        with candidate.open("rb") as handle:
            record = native.SafeUnpickler(handle).load()
        if not isinstance(record, dict):
            return None
        native.validate_model_schema(record)
        if str(record.get("modelType") or "") != str(kind):
            return None
        if training_run_id and record.get("trainingRunId") not in {None, training_run_id}:
            return None
        if int(record.get("durationValue")) != int(duration_value):
            return None
        if str(record.get("durationUnit")) != str(duration_unit):
            return None
        return record
    except Exception:
        return None


def load_duration(kind: str, symbol: str, duration_value: int, duration_unit: str, training_run_id: str | None = None, artifact_path: str | None = None) -> Any | None:
    if artifact_path:
        return load_record_from_path(artifact_path, kind, duration_value, duration_unit, training_run_id)
    candidates = [model_path(kind, symbol, duration_value, duration_unit, training_run_id)]
    if training_run_id:
        candidates.append(model_path(kind, symbol, duration_value, duration_unit, None))
    for path in candidates:
        record = load_record_from_path(path, kind, duration_value, duration_unit, training_run_id)
        if record is not None:
            return record
    return None


def save_duration(kind: str, symbol: str, duration_value: int, duration_unit: str, model: dict[str, Any], training_run_id: str | None = None) -> Path:
    schema = native.require_schema()
    model.update({
        "schemaFingerprint": schema["schemaFingerprint"],
        "featureSchemaVersion": schema["featureSchemaVersion"],
        "featureCount": schema["featureCount"],
        "featureOrder": list(schema["featureOrder"]),
        "sequenceLength": schema["sequenceLength"],
        "canonicalFeatureWindowTicks": schema["canonicalFeatureWindowTicks"],
        "durationValue": int(duration_value),
        "durationUnit": str(duration_unit),
        "trainingRunId": training_run_id,
    })
    path = model_path(kind, symbol, duration_value, duration_unit, training_run_id)
    temporary = Path(f"{path}.tmp")
    with temporary.open("wb") as handle:
        pickle.dump(model, handle, pickle.HIGHEST_PROTOCOL)
    temporary.replace(path)
    return path
