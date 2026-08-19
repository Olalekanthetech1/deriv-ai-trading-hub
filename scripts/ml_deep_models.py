"""Small, trainable PyTorch sequence models used by the native ML runtime."""
import math
import os
import resource
import time
from typing import Callable

def _require_native(exc: Exception, name: str) -> None:
    if os.getenv("RENDER") == "true" or os.getenv("NODE_ENV") == "production":
        raise RuntimeError(f"FATAL: Missing native ML production dependency '{name}'. Fallback strictly prohibited in production. Error: {exc}")

try:
    import numpy as np
except Exception as e:
    _require_native(e, "numpy")
    import pure_ml_engine as np

try:
    import torch
    import torch.nn as nn
    _Module = nn.Module
except Exception as e:
    _require_native(e, "torch")
    torch = None
    nn = None
    _Module = object

FEATURE_COUNT = 37
SEQUENCE_LENGTH = 25

ProgressCallback = Callable[[dict], None]


def _configure_torch_threads():
    if torch is None:
        return
    raw_cpu = os.getenv("RENDER_CPU_COUNT", "").strip()
    try:
        cpu_count = float(raw_cpu) if raw_cpu else float(os.cpu_count() or 1)
    except ValueError:
        cpu_count = float(os.cpu_count() or 1)
    raw_concurrency = os.getenv("ML_TRAINING_CONCURRENCY", "1").strip()
    try:
        concurrency = max(1, int(raw_concurrency))
    except ValueError:
        concurrency = 1
    thread_budget = max(1, int(math.floor(max(0.25, cpu_count) / min(concurrency, 16))))
    try:
        torch.set_num_threads(thread_budget)
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass


_configure_torch_threads()


def _peak_rss_bytes() -> int | None:
    """Return process peak RSS when the platform exposes it."""
    try:
        value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        # Linux reports KiB; macOS reports bytes. Render uses Linux containers.
        if os.name == "posix" and value < 10_000_000:
            return value * 1024
        return value
    except (AttributeError, OSError, ValueError):
        return None


class TCN(_Module):
    def __init__(self):
        super().__init__()
        if nn is not None:
            self.net = nn.Sequential(
                nn.Conv1d(FEATURE_COUNT, 64, 3, padding=1), nn.ReLU(),
                nn.Conv1d(64, 64, 3, padding=2, dilation=2), nn.ReLU(),
                nn.AdaptiveAvgPool1d(1), nn.Flatten(), nn.Linear(64, 2)
            )

    def forward(self, x):
        return self.net(x.transpose(1, 2))


class LSTM(_Module):
    def __init__(self):
        super().__init__()
        if nn is not None:
            self.rnn = nn.LSTM(FEATURE_COUNT, 64, batch_first=True)
            self.head = nn.Linear(64, 2)

    def forward(self, x):
        return self.head(self.rnn(x)[0][:, -1, :])


class Transformer(_Module):
    def __init__(self):
        super().__init__()
        if nn is not None:
            self.proj = nn.Linear(FEATURE_COUNT, 64)
            layer = nn.TransformerEncoderLayer(
                d_model=64,
                nhead=4,
                batch_first=True,
                dropout=0.1,
            )
            self.encoder = nn.TransformerEncoder(layer, num_layers=2)
            self.head = nn.Linear(64, 2)

    def forward(self, x):
        return self.head(self.encoder(self.proj(x))[:, -1, :])


def make(kind):
    if kind == "tcn":
        return TCN()
    if kind == "lstm":
        return LSTM()
    if kind == "transformer":
        return Transformer()
    raise ValueError(kind)


def train(
    kind,
    X,
    y,
    epochs=8,
    batch_size=64,
    lr=0.001,
    progress: ProgressCallback | None = None,
):
    if torch is None:
        import pure_ml_engine as _pure
        return _pure.train_pure_sequence(kind, X, y, epochs=epochs, batch_size=batch_size, lr=lr)
    torch.manual_seed(42)
    model = make(kind)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()
    tensor_started = time.perf_counter()
    xt = torch.tensor(X, dtype=torch.float32)
    yt = torch.tensor(y, dtype=torch.long)
    tensor_ms = round((time.perf_counter() - tensor_started) * 1000.0, 3)
    model.train()

    total_started = time.perf_counter()
    completed_epochs = 0
    total_batches = 0
    last_loss = None

    if progress:
        progress({
            "phase": "tensorized",
            "tensorMs": tensor_ms,
            "samples": len(xt),
            "sequenceLength": int(xt.shape[1]) if xt.ndim >= 2 else None,
            "featureCount": int(xt.shape[2]) if xt.ndim >= 3 else None,
            "peakRssBytes": _peak_rss_bytes(),
        })

    for epoch in range(max(1, epochs)):
        epoch_started = time.perf_counter()
        order = torch.randperm(len(xt))
        epoch_batches = 0
        epoch_loss = 0.0
        for s in range(0, len(order), batch_size):
            idx = order[s:s + batch_size]
            opt.zero_grad(set_to_none=True)
            loss = loss_fn(model(xt[idx]), yt[idx])
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            epoch_batches += 1
            total_batches += 1
            epoch_loss += float(loss.detach().cpu().item())

        completed_epochs += 1
        last_loss = epoch_loss / max(1, epoch_batches)
        epoch_ms = round((time.perf_counter() - epoch_started) * 1000.0, 3)
        total_ms = round((time.perf_counter() - total_started) * 1000.0, 3)
        if progress:
            progress({
                "phase": "epoch_complete",
                "epoch": completed_epochs,
                "epochs": max(1, epochs),
                "epochMs": epoch_ms,
                "trainingMs": total_ms,
                "batches": epoch_batches,
                "totalBatches": total_batches,
                "loss": round(last_loss, 8),
                "peakRssBytes": _peak_rss_bytes(),
            })

    if progress:
        progress({
            "phase": "fit_complete",
            "epochsCompleted": completed_epochs,
            "trainingMs": round((time.perf_counter() - total_started) * 1000.0, 3),
            "loss": round(last_loss, 8) if last_loss is not None else None,
            "peakRssBytes": _peak_rss_bytes(),
        })
    return model


def predict(kind, state_dict, X):
    if torch is None:
        import pure_ml_engine as _pure
        return _pure.predict_pure_sequence(kind, state_dict, X)
    model = make(kind)
    model.load_state_dict(state_dict)
    model.eval()
    with torch.no_grad():
        return torch.softmax(model(torch.tensor(X, dtype=torch.float32)), dim=-1).cpu().numpy()
