"""Governed wrapper around duration training.

Keeps the native training implementation unchanged while deriving exact validation
F1 from the same persisted validation partition and the newly trained artifact.
"""
from __future__ import annotations

import pickle
import sys
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

try:
    import numpy as np
except Exception:
    import pure_ml_engine as np

try:
    from sklearn.metrics import f1_score
except Exception:
    import pure_ml_engine as _pure
    f1_score = _pure.f1_score

import ml_duration_training as base_training
from ml_deep_models import predict as predict_deep
from ml_duration_artifacts import save_duration

SUPERVISED_PREDICTIVE_MODELS = {"xgboost", "lightgbm", "catboost", "tcn", "lstm"}


def _validation_partition(payload: dict[str, Any], kind: str):
    sequence = kind in {"tcn", "lstm"}
    key = "validationSequenceDataset" if sequence else "validationTabularDataset"
    data = payload.get(key)
    if not isinstance(data, dict):
        raise ValueError(f"{key.upper()}_REQUIRED")
    vectors = data.get("featureSequences" if sequence else "featureVectors")
    labels = data.get("labels")
    if not isinstance(vectors, list) or not isinstance(labels, list) or len(vectors) != len(labels) or not vectors:
        raise ValueError(f"INVALID_{key.upper()}")
    if sequence:
        X = np.asarray([[[float(x) for x in row] for row in seq] for seq in vectors], dtype=np.float32)
    else:
        X = np.asarray([[float(x) for x in row] for row in vectors], dtype=np.float32)
    y = np.asarray([int(v) for v in labels], dtype=np.int64)
    return X, y


def _predict_from_artifact(kind: str, record: dict[str, Any], X: np.ndarray) -> np.ndarray:
    if kind in {"tcn", "lstm"}:
        state_dict = record.get("state_dict")
        if not isinstance(state_dict, dict):
            raise ValueError("SEQUENCE_ARTIFACT_STATE_DICT_MISSING")
        probabilities = predict_deep(kind, state_dict, X)
        return np.argmax(probabilities, axis=1)

    model = record.get("model")
    if model is None or not hasattr(model, "predict"):
        raise ValueError("PREDICTIVE_ARTIFACT_MODEL_MISSING")
    return np.asarray(model.predict(X), dtype=np.int64)


def train_partitioned(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    result = base_training.train_partitioned(kind, payload)
    if not result.get("success") or kind not in SUPERVISED_PREDICTIVE_MODELS:
        if result.get("success"):
            result.setdefault("metrics", {})["modelKey"] = kind
        return result

    artifact_path = str(result.get("artifactPath") or "").strip()
    if not artifact_path:
        raise ValueError("TRAINED_ARTIFACT_PATH_MISSING")

    validation_X, validation_y = _validation_partition(payload, kind)
    with Path(artifact_path).open("rb") as handle:
        record = native.SafeUnpickler(handle).load()
    if not isinstance(record, dict):
        raise ValueError("TRAINED_ARTIFACT_INVALID")

    predictions = _predict_from_artifact(kind, record, validation_X)
    f1 = round(float(f1_score(validation_y, predictions, zero_division=0)), 6)

    validation = record.get("validation") if isinstance(record.get("validation"), dict) else {}
    validation = dict(validation)
    validation["f1"] = f1
    validation["modelKey"] = kind
    record["validation"] = validation
    record["modelKey"] = kind

    save_duration(
        kind,
        str(payload.get("symbol") or ""),
        int(payload.get("durationValue")),
        str(payload.get("durationUnit") or ""),
        record,
        str(payload.get("trainingRunId") or "") or None,
    )

    metrics = dict(result.get("metrics") or {})
    metrics["f1"] = f1
    metrics["modelKey"] = kind
    result["metrics"] = metrics
    result["f1"] = f1
    return result
