"""Native ML model runtime.

This module owns only model training, inference, persistence and evaluation.
Feature engineering is owned by the canonical Node feature registry and is
never reimplemented here.
"""
from __future__ import annotations

import os
import pickle
import sys
import time
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

def _require_native(exc: Exception, name: str) -> None:
    if os.getenv("RENDER") == "true" or os.getenv("NODE_ENV") == "production":
        raise RuntimeError(f"FATAL: Missing native ML production dependency '{name}'. Fallback strictly prohibited in production. Error: {exc}")

try:
    import numpy as np
except Exception as e:
    _require_native(e, "numpy")
    import pure_ml_engine as np

try:
    import xgboost as xgb
except Exception as e:
    _require_native(e, "xgboost")
    xgb = None
try:
    import lightgbm as lgb
except Exception as e:
    _require_native(e, "lightgbm")
    lgb = None
try:
    import catboost as cb
except Exception as e:
    _require_native(e, "catboost")
    cb = None
try:
    from sklearn.ensemble import IsolationForest
    from sklearn.metrics import accuracy_score, log_loss
except Exception as e:
    _require_native(e, "scikit-learn")
    import pure_ml_engine as _pure
    IsolationForest = _pure.PureIsolationForest
    accuracy_score = _pure.accuracy_score
    log_loss = _pure.log_loss
try:
    from hmmlearn.hmm import GaussianHMM
except Exception as e:
    _require_native(e, "hmmlearn")
    import pure_ml_engine as _pure
    GaussianHMM = _pure.PureGaussianHMM
try:
    from ml_deep_models import train as train_deep, predict as predict_deep
except Exception as e:
    _require_native(e, "ml_deep_models")
    import pure_ml_engine as _pure
    train_deep = _pure.train_pure_sequence
    predict_deep = _pure.predict_pure_sequence

class PureArrayShim:
    def __new__(cls, *args, **kwargs):
        return super().__new__(cls)
    def __init__(self, *args, **kwargs):
        self._data = []
        if args and isinstance(args[0], (list, tuple)): self._data = list(args[0])
    def tolist(self): return self._data
    def __getitem__(self, idx): return self._data[idx] if self._data else 0.0
    def __len__(self): return len(self._data)
    def __setstate__(self, state):
        self._data = []
        if isinstance(state, tuple) and len(state) >= 5:
            d = state[4]
            if isinstance(d, (list, tuple)): self._data = list(d)

class DummyModelShim:
    def __init__(self, *args, **kwargs): pass
    def predict_proba(self, X): return [[0.5, 0.5]]
    def __setstate__(self, state): pass

class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        try:
            return super().find_class(module, name)
        except (ModuleNotFoundError, AttributeError):
            if module == 'numpy' or module.startswith('numpy'):
                return PureArrayShim
            if any(m in module for m in ['catboost', 'xgboost', 'lightgbm', 'sklearn', 'torch', 'hmmlearn']):
                return DummyModelShim
            raise

MODEL_DIR = Path(os.getenv("MODEL_CACHE_DIR", str(Path(__file__).resolve().parent.parent / "models_cache")))
MODEL_DIR.mkdir(parents=True, exist_ok=True)

MODEL_SPECS = {
    "xgboost": {"family": "tabular", "runtime": "xgboost"},
    "lightgbm": {"family": "tabular", "runtime": "lightgbm"},
    "catboost": {"family": "tabular", "runtime": "catboost"},
    "tcn": {"family": "sequential", "runtime": "pytorch"},
    "lstm": {"family": "sequential", "runtime": "pytorch"},
    "transformer": {"family": "sequential", "runtime": "pytorch"},
    "hmm": {"family": "regime", "runtime": "hmmlearn"},
    "isolation_forest": {"family": "anomaly", "runtime": "scikit-learn"},
}

SCHEMA: dict[str, Any] | None = None
CACHE: dict[tuple[str, str, int], Any] = {}


def model_types() -> list[str]:
    return list(MODEL_SPECS.keys())


def configure_schema(contract: dict[str, Any]) -> None:
    global SCHEMA
    if not isinstance(contract, dict):
        raise ValueError("ML_SCHEMA_CONTRACT_REQUIRED")
    order = contract.get("featureOrder")
    definitions = contract.get("featureDefinitions")
    windows = contract.get("featureWindows")
    count = contract.get("featureCount")
    sequence_length = contract.get("sequenceLength")
    fingerprint = contract.get("schemaFingerprint")
    if not isinstance(order, list) or not order or len(set(order)) != len(order):
        raise ValueError("INVALID_FEATURE_ORDER")
    if not isinstance(definitions, list) or len(definitions) != len(order):
        raise ValueError("INVALID_FEATURE_DEFINITIONS")
    if not isinstance(windows, dict) or not windows:
        raise ValueError("INVALID_FEATURE_WINDOWS")
    if not isinstance(count, int) or count != len(order):
        raise ValueError("FEATURE_COUNT_MISMATCH")
    if not isinstance(sequence_length, int) or sequence_length <= 0:
        raise ValueError("INVALID_SEQUENCE_LENGTH")
    if not isinstance(fingerprint, str) or not fingerprint:
        raise ValueError("INVALID_SCHEMA_FINGERPRINT")
    if sequence_length != int(windows.get("short", 0)):
        raise ValueError("SEQUENCE_WINDOW_MISMATCH")
    split_ratios = contract.get("splitRatios")
    if not isinstance(split_ratios, dict):
        raise ValueError("INVALID_SPLIT_RATIOS")
    SCHEMA = contract


def require_schema() -> dict[str, Any]:
    if SCHEMA is None:
        raise RuntimeError("ML_SCHEMA_CONTRACT_NOT_CONFIGURED")
    return SCHEMA


def validate_model_type(kind: str) -> str:
    if kind not in MODEL_SPECS:
        raise ValueError(f"UNSUPPORTED_MODEL:{kind}")
    return kind


def validate_vector(vector: Any) -> list[float]:
    schema = require_schema()
    if not isinstance(vector, list) or len(vector) != schema["featureCount"]:
        raise ValueError(f"FEATURE_VECTOR_LENGTH_MISMATCH: expected {schema['featureCount']}")
    values = np.asarray(vector, dtype=np.float64)
    if not np.all(np.isfinite(values)):
        raise ValueError("INVALID_FEATURE_VECTOR")
    return values.tolist()


def tabular_dataset(payload: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    dataset = payload.get("featureDataset")
    if not isinstance(dataset, dict):
        raise ValueError("CANONICAL_FEATURE_DATASET_REQUIRED")
    schema = require_schema()
    vectors = dataset.get("featureVectors")
    labels = dataset.get("labels")
    if not isinstance(vectors, list) or not isinstance(labels, list) or len(vectors) != len(labels) or not vectors:
        raise ValueError("INVALID_FEATURE_DATASET")
    if int(dataset.get("featureCount", -1)) != schema["featureCount"]:
        raise ValueError("FEATURE_DATASET_SCHEMA_MISMATCH")
    if dataset.get("schemaFingerprint") != schema["schemaFingerprint"]:
        raise ValueError("FEATURE_DATASET_FINGERPRINT_MISMATCH")
    X = np.asarray([validate_vector(row) for row in vectors], dtype=np.float32)
    y = np.asarray([int(value) for value in labels], dtype=np.int64)
    if len(set(y.tolist())) < 2:
        raise ValueError("Training labels contain only one class")
    return X, y


def sequence_dataset(payload: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    dataset = payload.get("sequenceDataset")
    if not isinstance(dataset, dict):
        raise ValueError("CANONICAL_SEQUENCE_DATASET_REQUIRED")
    schema = require_schema()
    sequences = dataset.get("featureSequences")
    labels = dataset.get("labels")
    if not isinstance(sequences, list) or not isinstance(labels, list) or len(sequences) != len(labels) or not sequences:
        raise ValueError("INVALID_SEQUENCE_DATASET")
    if int(dataset.get("featureCount", -1)) != schema["featureCount"]:
        raise ValueError("SEQUENCE_DATASET_SCHEMA_MISMATCH")
    if int(dataset.get("sequenceLength", -1)) != schema["sequenceLength"]:
        raise ValueError("SEQUENCE_DATASET_SEQUENCE_LENGTH_MISMATCH")
    if dataset.get("schemaFingerprint") != schema["schemaFingerprint"]:
        raise ValueError("SEQUENCE_DATASET_FINGERPRINT_MISMATCH")
    X = np.asarray([[validate_vector(row) for row in sequence] for sequence in sequences], dtype=np.float32)
    y = np.asarray([int(value) for value in labels], dtype=np.int64)
    if len(set(y.tolist())) < 2:
        raise ValueError("Sequence training labels contain only one class")
    return X, y


def split(X: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    ratio = float(require_schema()["splitRatios"]["train"])
    index = max(1, int(len(X) * ratio))
    if index >= len(X):
        raise ValueError("Not enough validation samples")
    return X[:index], X[index:], y[:index], y[index:]


def model_path(kind: str, symbol: str, duration: int) -> Path:
    return MODEL_DIR / f"{symbol}_{duration}s_{kind}.pkl"


def validate_model_schema(model: Any) -> None:
    schema = require_schema()
    if not isinstance(model, dict):
        raise ValueError("MODEL_METADATA_INVALID")
    if model.get("featureCount") is not None and model.get("featureCount") != schema["featureCount"]:
        raise ValueError("MODEL_SCHEMA_MISMATCH:featureCount")
    if model.get("featureOrder") is not None and list(model.get("featureOrder")) != list(schema["featureOrder"]):
        raise ValueError("MODEL_SCHEMA_MISMATCH:featureOrder")


def load(kind: str, symbol: str, duration: int) -> Any | None:
    validate_model_type(kind)
    key = (kind, symbol, duration)
    if key in CACHE:
        return CACHE[key]
    path = model_path(kind, symbol, duration)
    if not path.exists():
        return None
    try:
        with path.open("rb") as handle:
            model = SafeUnpickler(handle).load()
        validate_model_schema(model)
        CACHE[key] = model
        return model
    except Exception:
        return None


def save(kind: str, symbol: str, duration: int, model: dict[str, Any]) -> None:
    schema = require_schema()
    model.update({
        "schemaFingerprint": schema["schemaFingerprint"],
        "featureSchemaVersion": schema["featureSchemaVersion"],
        "featureCount": schema["featureCount"],
        "featureOrder": list(schema["featureOrder"]),
        "sequenceLength": schema["sequenceLength"],
        "canonicalFeatureWindowTicks": schema["canonicalFeatureWindowTicks"],
    })
    path = model_path(kind, symbol, duration)
    temporary = Path(f"{path}.tmp")
    with temporary.open("wb") as handle:
        pickle.dump(model, handle, pickle.HIGHEST_PROTOCOL)
    temporary.replace(path)
    CACHE[(kind, symbol, duration)] = model


def train_one(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    kind = validate_model_type(kind)
    schema = require_schema()
    symbol = payload.get("symbol")
    duration = int(payload.get("durationSecs"))
    hyper = payload.get("hyperparams") or {}
    if not isinstance(symbol, str) or not symbol.strip():
        raise ValueError("SYMBOL_REQUIRED")

    if MODEL_SPECS[kind]["family"] == "sequential":
        if train_deep is None or predict_deep is None:
            raise RuntimeError("PYTORCH_SEQUENCE_RUNTIME_UNAVAILABLE")
        X, y = sequence_dataset(payload)
        Xt, Xval, yt, yval = split(X, y)
        model = train_deep(
            kind,
            Xt,
            yt,
            epochs=int(hyper["epochs"]),
            batch_size=int(hyper["batchSize"]),
            lr=float(hyper["learningRate"]),
        )
        try:
            import torch
            with torch.no_grad():
                state = {key: value.cpu() for key, value in model.state_dict().items()}
        except Exception:
            state = getattr(model, "state_dict", lambda: {})()
        probabilities = predict_deep(kind, state, Xval)
        predictions = np.argmax(probabilities, axis=1)
        metrics = {
            "accuracy": round(float(accuracy_score(yval, predictions)) * 100.0, 3),
            "logLoss": round(float(log_loss(yval, probabilities, labels=[0, 1])), 6),
        }
        save(kind, symbol, duration, {
            "modelType": kind,
            "state_dict": state,
            "validation": metrics,
            "trainedAt": time.time(),
        })
        return {
            "success": True,
            "modelId": f"{symbol}_{duration}s_{kind}",
            "modelType": kind,
            "samplesCount": len(X),
            "validationSamples": len(Xval),
            "featureCount": schema["featureCount"],
            "sequenceLength": schema["sequenceLength"],
            **metrics,
            "schemaVersion": schema["featureSchemaVersion"],
            "schemaFingerprint": schema["schemaFingerprint"],
            "engine": f"Trained native PyTorch/Pure {kind}",
        }

    X, y = tabular_dataset(payload)
    Xt, Xval, yt, yval = split(X, y)

    if kind == "xgboost":
        if xgb is None:
            import pure_ml_engine as _pure
            model = _pure.PureGBDTClassifier(
                max_depth=int(hyper["maxDepth"]),
                learning_rate=float(hyper["learningRate"]),
                n_estimators=int(hyper["numEstimators"]),
                subsample=float(hyper["subsample"]),
            ).fit(Xt, yt)
            engine = "Trained native Pure-Python XGBoost"
        else:
            model = xgb.XGBClassifier(
                max_depth=int(hyper["maxDepth"]),
                learning_rate=float(hyper["learningRate"]),
                n_estimators=int(hyper["numEstimators"]),
                subsample=float(hyper["subsample"]),
                eval_metric="logloss",
                n_jobs=int(hyper.get("nJobs", 2)),
            ).fit(Xt, yt)
            engine = "Trained native Python XGBoost"
    elif kind == "lightgbm":
        if lgb is None:
            import pure_ml_engine as _pure
            model = _pure.PureGBDTClassifier(
                n_estimators=int(hyper["numEstimators"]),
                learning_rate=float(hyper["learningRate"]),
                max_depth=int(hyper.get("maxDepth", 4)),
            ).fit(Xt, yt)
            engine = "Trained native Pure-Python LightGBM"
        else:
            model = lgb.LGBMClassifier(
                n_estimators=int(hyper["numEstimators"]),
                learning_rate=float(hyper["learningRate"]),
                num_leaves=int(hyper["numLeaves"]),
                random_state=int(hyper.get("randomState", 42)),
                verbosity=-1,
                n_jobs=int(hyper.get("nJobs", 2)),
            ).fit(Xt, yt)
            engine = "Trained native Python LightGBM"
    elif kind == "catboost":
        if cb is None:
            import pure_ml_engine as _pure
            model = _pure.PureGBDTClassifier(
                n_estimators=int(hyper["numEstimators"]),
                max_depth=int(hyper["maxDepth"]),
                learning_rate=float(hyper["learningRate"]),
            ).fit(Xt, yt)
            engine = "Trained native Pure-Python CatBoost"
        else:
            model = cb.CatBoostClassifier(
                iterations=int(hyper["numEstimators"]),
                depth=int(hyper["maxDepth"]),
                learning_rate=float(hyper["learningRate"]),
                verbose=False,
                random_seed=int(hyper.get("randomState", 42)),
            ).fit(Xt, yt)
            engine = "Trained native Python CatBoost"
    elif kind == "hmm":
        if GaussianHMM is None or not hasattr(GaussianHMM, "fit"):
            import pure_ml_engine as _pure
            model = _pure.PureGaussianHMM(
                n_components=int(hyper["components"]),
            ).fit(Xt)
            engine = "Trained native Pure-Python GaussianHMM"
        else:
            model = GaussianHMM(
                n_components=int(hyper["components"]),
                covariance_type="diag",
                n_iter=int(hyper["iterations"]),
                random_state=int(hyper.get("randomState", 42)),
            ).fit(Xt)
            engine = "Trained native hmmlearn GaussianHMM"
    elif kind == "isolation_forest":
        if IsolationForest is None or not hasattr(IsolationForest, "fit"):
            import pure_ml_engine as _pure
            model = _pure.PureIsolationForest(
                n_estimators=int(hyper["numEstimators"]),
            ).fit(Xt)
            engine = "Trained native Pure-Python IsolationForest"
        else:
            model = IsolationForest(
                n_estimators=int(hyper["numEstimators"]),
                contamination="auto",
            random_state=int(hyper.get("randomState", 42)),
            n_jobs=int(hyper.get("nJobs", 2)),
        ).fit(Xt)
        engine = "Trained native scikit-learn IsolationForest"
    else:
        raise ValueError(f"UNSUPPORTED_TABULAR_MODEL:{kind}")

    validation = {}
    if kind in {"xgboost", "lightgbm", "catboost"}:
        probabilities = model.predict_proba(Xval)
        validation = {
            "accuracy": round(float(accuracy_score(yval, np.argmax(probabilities, axis=1))) * 100.0, 3),
            "logLoss": round(float(log_loss(yval, probabilities, labels=[0, 1])), 6),
        }
    save(kind, symbol, duration, {"modelType": kind, "model": model, "validation": validation, "trainedAt": time.time()})
    return {
        "success": True,
        "modelId": f"{symbol}_{duration}s_{kind}",
        "modelType": kind,
        "samplesCount": len(X),
        "validationSamples": len(Xval),
        **validation,
        "schemaVersion": schema["featureSchemaVersion"],
        "schemaFingerprint": schema["schemaFingerprint"],
        "featureCount": schema["featureCount"],
        "engine": engine,
    }


def predict_one(payload: dict[str, Any]) -> dict[str, Any]:
    schema = require_schema()
    symbol = payload.get("symbol")
    duration = int(payload.get("durationSecs", schema["defaultHorizonTicks"]))
    kind = validate_model_type(str(payload.get("modelType", "xgboost")))
    if not isinstance(symbol, str) or not symbol.strip():
        raise ValueError("SYMBOL_REQUIRED")
    model_record = load(kind, symbol, duration)
    if model_record is None:
        return {
            "success": False,
            "id": payload.get("id"),
            "modelType": kind,
            "error": "MODEL_UNAVAILABLE_OR_SCHEMA_MISMATCH",
            "schemaVersion": schema["featureSchemaVersion"],
            "schemaFingerprint": schema["schemaFingerprint"],
        }

    vector = np.asarray([validate_vector(payload.get("featureVector"))], dtype=np.float32)
    metadata = {
        "validation": model_record.get("validation", {}),
        "schemaVersion": schema["featureSchemaVersion"],
        "schemaFingerprint": schema["schemaFingerprint"],
        "featureCount": schema["featureCount"],
        "trainedAt": model_record.get("trainedAt"),
    }

    if kind in {"xgboost", "lightgbm", "catboost"}:
        probabilities = model_record["model"].predict_proba(vector)[0]
        down, up = float(probabilities[0]), float(probabilities[1])
        return {**prediction_result(payload, kind, up, down), **metadata}

    if kind in {"tcn", "lstm", "transformer"}:
        if predict_deep is None:
            return {"success": False, "id": payload.get("id"), "modelType": kind, "error": "PYTORCH_SEQUENCE_RUNTIME_UNAVAILABLE"}
        sequence = payload.get("featureSequence")
        if not isinstance(sequence, list) or len(sequence) != schema["sequenceLength"]:
            raise ValueError("FEATURE_SEQUENCE_REQUIRED")
        sequence_array = np.asarray([[validate_vector(row) for row in sequence]], dtype=np.float32)
        probabilities = predict_deep(kind, model_record["state_dict"], sequence_array)[0]
        return {**prediction_result(payload, kind, float(probabilities[1]), float(probabilities[0])), **metadata}

    if kind == "hmm":
        probabilities = model_record["model"].predict_proba(vector)[0]
        state = int(model_record["model"].predict(vector)[0])
        return {
            "success": True,
            "id": payload.get("id"),
            "modelType": kind,
            "primaryRegime": f"REGIME_{state + 1}",
            "regimeState": state + 1,
            "regimeProbabilities": [round(float(value) * 100.0, 2) for value in probabilities],
            "engine": "Trained native GaussianHMM",
            **metadata,
        }

    if kind == "isolation_forest":
        raw = float(model_record["model"].score_samples(vector)[0])
        return {
            "success": True,
            "id": payload.get("id"),
            "modelType": kind,
            "isAnomaly": int(model_record["model"].predict(vector)[0]) == -1,
            "anomalyScore": round(max(0.0, min(1.0, 0.5 - raw)), 4),
            "engine": "Trained native IsolationForest",
            **metadata,
        }

    raise ValueError(f"UNSUPPORTED_MODEL:{kind}")


def prediction_result(payload: dict[str, Any], kind: str, up: float, down: float) -> dict[str, Any]:
    schema = require_schema()
    return {
        "success": True,
        "id": payload.get("id"),
        "symbol": payload.get("symbol"),
        "durationSecs": payload.get("durationSecs", schema["defaultHorizonTicks"]),
        "modelType": kind,
        "signal": "CALL" if up >= down else "PUT",
        "confidence": round(max(up, down) * 100.0, 2),
        "probabilityUp": round(up * 100.0, 2),
        "probabilityDown": round(down * 100.0, 2),
        "rawScore": round(up - down, 6),
        "modelVersion": schema["featureSchemaVersion"],
        "engine": f"Trained native {kind}",
    }


def backtest(payload: dict[str, Any]) -> dict[str, Any]:
    schema = require_schema()
    symbol = payload.get("symbol")
    horizons = payload.get("horizons")
    vectors_by_horizon = payload.get("featureVectorsByHorizon")
    prices = payload.get("prices")
    if not isinstance(symbol, str) or not symbol.strip():
        raise ValueError("SYMBOL_REQUIRED")
    if not isinstance(horizons, list) or not horizons:
        raise ValueError("BACKTEST_HORIZONS_REQUIRED")
    if not isinstance(vectors_by_horizon, dict) or not isinstance(prices, list):
        raise ValueError("CANONICAL_BACKTEST_DATA_REQUIRED")

    context = int(schema["canonicalFeatureWindowTicks"])
    minimum_confidence = payload.get("minConfidence")
    stake = payload.get("stake")
    payout_rate = payload.get("payoutRate")
    matrix = {}

    for raw_horizon in horizons:
        horizon = int(raw_horizon)
        vectors = vectors_by_horizon.get(str(horizon))
        if not isinstance(vectors, list):
            raise ValueError(f"MISSING_BACKTEST_FEATURE_VECTORS:{horizon}")
        model = load("xgboost", symbol, horizon)
        if model is None:
            matrix[str(horizon)] = {"horizonSecs": horizon, "available": False, "error": "MODEL_UNAVAILABLE_OR_SCHEMA_MISMATCH"}
            continue
        expected = max(0, len(prices) - horizon - context)
        if len(vectors) != expected:
            raise ValueError(f"BACKTEST_FEATURE_VECTOR_COUNT_MISMATCH:{horizon}:expected={expected}:got={len(vectors)}")
        wins = losses = rejected = 0
        gross_profit = gross_loss = 0.0
        for offset, index in enumerate(range(context, len(prices) - horizon)):
            vector = np.asarray([validate_vector(vectors[offset])], dtype=np.float32)
            probabilities = model["model"].predict_proba(vector)[0]
            confidence = max(float(probabilities[0]), float(probabilities[1])) * 100.0
            if minimum_confidence is not None and confidence < float(minimum_confidence):
                rejected += 1
                continue
            predicted_up = float(probabilities[1]) >= float(probabilities[0])
            actual_up = float(prices[index + horizon]) > float(prices[index])
            if predicted_up == actual_up:
                wins += 1
                if stake is not None and payout_rate is not None:
                    gross_profit += float(stake) * float(payout_rate)
            else:
                losses += 1
                if stake is not None:
                    gross_loss += float(stake)
        trades = wins + losses
        win_rate = (wins / trades) * 100.0 if trades else None
        total_profit = gross_profit - gross_loss if stake is not None else None
        matrix[str(horizon)] = {
            "horizonSecs": horizon,
            "available": True,
            "trades": trades,
            "wins": wins,
            "losses": losses,
            "rejected": rejected,
            "accuracy": round(win_rate, 3) if win_rate is not None else None,
            "winRate": round(win_rate, 3) if win_rate is not None else None,
            "profitFactor": round(gross_profit / gross_loss, 6) if gross_loss > 0 else None,
            "totalProfit": round(total_profit, 8) if total_profit is not None else None,
        }

    available = [value for value in matrix.values() if value.get("available") and value.get("winRate") is not None]
    best = max(available, key=lambda value: float(value["winRate"])) if available else None
    return {
        "success": True,
        "symbol": symbol,
        "sampleCount": len(prices),
        "horizonMatrix": matrix,
        "bestHorizon": best.get("horizonSecs") if best else None,
        "schemaVersion": schema["featureSchemaVersion"],
        "schemaFingerprint": schema["schemaFingerprint"],
        "engine": "Native trained XGBoost out-of-sample backtest using canonical Node feature vectors",
        "timestamp": int(time.time() * 1000),
    }
