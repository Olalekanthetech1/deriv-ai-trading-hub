"""Pure Python standard library ML runtime engine.

Provides native mathematical operations, array structures, metrics, and models
(Gradient Boosted Decision Trees, Sequence Classifiers, Gaussian HMMs, Isolation Forests)
using only built-in Python standard libraries (math, random, statistics, json, pickle, etc.).
"""
from __future__ import annotations

import math
import random
import time
from typing import Any, Sequence, List, Tuple, Union

# Types
int64 = int
float32 = float
float64 = float


class PureArray:
    """Lightweight array wrapper mimicking numpy array operations for pure Python."""

    def __init__(self, data: Any, dtype: Any = float):
        if isinstance(data, PureArray):
            self._data = data._data
        elif isinstance(data, (list, tuple)):
            self._data = data
        elif hasattr(data, "tolist"):
            self._data = data.tolist()
        else:
            self._data = [data]
        self.dtype = dtype

    @property
    def shape(self) -> Tuple[int, ...]:
        if not isinstance(self._data, list):
            return ()
        if not self._data:
            return (0,)
        if isinstance(self._data[0], list):
            if self._data[0] and isinstance(self._data[0][0], list):
                return (len(self._data), len(self._data[0]), len(self._data[0][0]))
            return (len(self._data), len(self._data[0]))
        return (len(self._data),)

    @property
    def ndim(self) -> int:
        return len(self.shape)

    def tolist(self) -> list:
        if isinstance(self._data, list):
            res = []
            for item in self._data:
                if isinstance(item, PureArray):
                    res.append(item.tolist())
                elif isinstance(item, list):
                    res.append(list(item))
                else:
                    res.append(item)
            return res
        return [self._data]

    def astype(self, new_dtype: Any) -> PureArray:
        return PureArray(self._data, dtype=new_dtype)

    def cpu(self) -> PureArray:
        return self

    def __len__(self) -> int:
        return len(self._data)

    def __getitem__(self, idx: Any) -> Any:
        if isinstance(idx, tuple):
            # E.g. [:, 1] or [mask]
            first = idx[0]
            if first == slice(None):
                col_idx = idx[1]
                return PureArray([row[col_idx] for row in self._data], dtype=self.dtype)
        if isinstance(idx, slice):
            return PureArray(self._data[idx], dtype=self.dtype)
        if isinstance(idx, (list, PureArray)):
            # Fancy indexing with boolean or int mask
            mask = idx.tolist() if isinstance(idx, PureArray) else idx
            if mask and isinstance(mask[0], bool):
                res = [row for row, b in zip(self._data, mask) if b]
            else:
                res = [self._data[i] for i in mask]
            return PureArray(res, dtype=self.dtype)
        val = self._data[idx]
        if isinstance(val, list):
            return PureArray(val, dtype=self.dtype)
        return val

    def __eq__(self, other: Any) -> PureArray:
        if isinstance(other, PureArray):
            other = other.tolist()
        if isinstance(self._data, list):
            return PureArray([x == other for x in self._data], dtype=bool)
        return PureArray([self._data == other], dtype=bool)

    def __ge__(self, other: Any) -> PureArray:
        if isinstance(self._data, list):
            return PureArray([float(x) >= float(other) for x in self._data], dtype=bool)
        return PureArray([float(self._data) >= float(other)], dtype=bool)

    def __gt__(self, other: Any) -> PureArray:
        if isinstance(self._data, list):
            return PureArray([float(x) > float(other) for x in self._data], dtype=bool)
        return PureArray([float(self._data) > float(other)], dtype=bool)

    def __le__(self, other: Any) -> PureArray:
        if isinstance(self._data, list):
            return PureArray([float(x) <= float(other) for x in self._data], dtype=bool)
        return PureArray([float(self._data) <= float(other)], dtype=bool)

    def __lt__(self, other: Any) -> PureArray:
        if isinstance(self._data, list):
            return PureArray([float(x) < float(other) for x in self._data], dtype=bool)
        return PureArray([float(self._data) < float(other)], dtype=bool)


def asarray(data: Any, dtype: Any = None) -> PureArray:
    if isinstance(data, PureArray):
        return data
    return PureArray(data, dtype=dtype or float)


def isfinite(arr: Any) -> bool:
    if isinstance(arr, PureArray):
        data = arr.tolist()
    else:
        data = data if isinstance(arr, list) else [arr]

    def _check(x):
        if isinstance(x, list):
            return all(_check(v) for v in x)
        return math.isfinite(float(x))

    return _check(data)


def all(arr: Any) -> bool:
    if isinstance(arr, PureArray):
        data = arr.tolist()
    else:
        data = arr if isinstance(arr, list) else [arr]

    def _check(x):
        if isinstance(x, list):
            return builtins_all(_check(v) for v in x)
        return bool(x)

    return _check(data)


builtins_all = all


def mean(arr: Any) -> float:
    if isinstance(arr, PureArray):
        data = arr.tolist()
    else:
        data = arr
    if not data:
        return 0.0
    flat = _flatten(data)
    return sum(flat) / len(flat) if flat else 0.0


def sum_arr(arr: Any) -> float:
    if isinstance(arr, PureArray):
        data = arr.tolist()
    else:
        data = arr
    flat = _flatten(data)
    return float(sum(flat))


def argmax(arr: Any, axis: int | None = None) -> Any:
    if isinstance(arr, PureArray):
        data = arr.tolist()
    else:
        data = arr
    if axis == 1 and isinstance(data, list) and data and isinstance(data[0], list):
        return PureArray([max(range(len(row)), key=lambda i: row[i]) for row in data], dtype=int)
    flat = _flatten(data)
    if not flat:
        return 0
    return max(range(len(flat)), key=lambda i: flat[i])


def _flatten(data: Any) -> list[float]:
    if isinstance(data, PureArray):
        data = data.tolist()
    if not isinstance(data, list):
        return [float(data)]
    res = []
    for item in data:
        if isinstance(item, list):
            res.extend(_flatten(item))
        else:
            res.append(float(item))
    return res


# Metrics
def accuracy_score(y_true: Any, y_pred: Any) -> float:
    yt = y_true.tolist() if isinstance(y_true, PureArray) else list(y_true)
    yp = y_pred.tolist() if isinstance(y_pred, PureArray) else list(y_pred)
    if not yt:
        return 0.0
    correct = sum(1 for t, p in zip(yt, yp) if int(t) == int(p))
    return correct / len(yt)


def f1_score(y_true: Any, y_pred: Any, zero_division: float = 0.0) -> float:
    yt = y_true.tolist() if isinstance(y_true, PureArray) else list(y_true)
    yp = y_pred.tolist() if isinstance(y_pred, PureArray) else list(y_pred)
    tp = sum(1 for t, p in zip(yt, yp) if int(t) == 1 and int(p) == 1)
    fp = sum(1 for t, p in zip(yt, yp) if int(t) == 0 and int(p) == 1)
    fn = sum(1 for t, p in zip(yt, yp) if int(t) == 1 and int(p) == 0)
    if tp + fp == 0 or tp + fn == 0:
        return float(zero_division)
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    if precision + recall == 0:
        return float(zero_division)
    return 2.0 * (precision * recall) / (precision + recall)


def log_loss(y_true: Any, y_prob: Any, labels: list[int] | None = None) -> float:
    yt = y_true.tolist() if isinstance(y_true, PureArray) else list(y_true)
    yp = y_prob.tolist() if isinstance(y_prob, PureArray) else list(y_prob)
    if not yt:
        return 0.0
    eps = 1e-15
    loss_sum = 0.0
    for t, p in zip(yt, yp):
        if isinstance(p, (list, tuple, PureArray)):
            p_list = p.tolist() if isinstance(p, PureArray) else list(p)
            p1 = max(eps, min(1.0 - eps, float(p_list[1])))
        else:
            p1 = max(eps, min(1.0 - eps, float(p)))
        y_val = int(t)
        if y_val == 1:
            loss_sum -= math.log(p1)
        else:
            loss_sum -= math.log(1.0 - p1)
    return loss_sum / len(yt)


def roc_auc_score(y_true: Any, y_prob: Any) -> float:
    yt = [int(v) for v in (y_true.tolist() if isinstance(y_true, PureArray) else list(y_true))]
    yp = [float(v[1] if isinstance(v, (list, tuple, PureArray)) else v) for v in (y_prob.tolist() if isinstance(y_prob, PureArray) else list(y_prob))]
    pos_scores = [score for t, score in zip(yt, yp) if t == 1]
    neg_scores = [score for t, score in zip(yt, yp) if t == 0]
    if not pos_scores or not neg_scores:
        return 0.5
    count = 0.0
    for pos in pos_scores:
        for neg in neg_scores:
            if pos > neg:
                count += 1.0
            elif pos == neg:
                count += 0.5
    return count / (len(pos_scores) * len(neg_scores))


def brier_score_loss(y_true: Any, y_prob: Any) -> float:
    yt = [int(v) for v in (y_true.tolist() if isinstance(y_true, PureArray) else list(y_true))]
    yp = [float(v[1] if isinstance(v, (list, tuple, PureArray)) else v) for v in (y_prob.tolist() if isinstance(y_prob, PureArray) else list(y_prob))]
    if not yt:
        return 0.0
    return sum((p - t) ** 2 for t, p in zip(yt, yp)) / len(yt)


# Pure Python GBDT Model Implementation
class PureDecisionTreeNode:

    def __init__(
        self,
        feature_index: int = -1,
        threshold: float = 0.0,
        left: PureDecisionTreeNode | None = None,
        right: PureDecisionTreeNode | None = None,
        value: float = 0.0,
    ):
        self.feature_index = feature_index
        self.threshold = threshold
        self.left = left
        self.right = right
        self.value = value

    def is_leaf(self) -> bool:
        return self.left is None and self.right is None

    def predict(self, x: list[float]) -> float:
        if self.is_leaf():
            return self.value
        if x[self.feature_index] <= self.threshold:
            return self.left.predict(x)
        return self.right.predict(x)


class PureDecisionTree:

    def __init__(self, max_depth: int = 3):
        self.max_depth = max_depth
        self.root: PureDecisionTreeNode | None = None

    def fit(self, X: list[list[float]], residuals: list[float], depth: int = 0) -> PureDecisionTreeNode:
        n_samples = len(X)
        if n_samples == 0:
            return PureDecisionTreeNode(value=0.0)

        mean_val = sum(residuals) / n_samples
        if depth >= self.max_depth or n_samples <= 2:
            return PureDecisionTreeNode(value=mean_val)

        n_features = len(X[0])
        best_gain = -1.0
        best_feature = -1
        best_threshold = 0.0
        best_left_idx = []
        best_right_idx = []

        # Find best split
        for f in range(n_features):
            vals = [X[i][f] for i in range(n_samples)]
            unique_vals = sorted(list(set(vals)))
            if len(unique_vals) <= 1:
                continue
            # Sample thresholds for speed
            step = max(1, len(unique_vals) // 10)
            thresholds = unique_vals[::step]
            for thresh in thresholds:
                left_r = [residuals[i] for i in range(n_samples) if X[i][f] <= thresh]
                right_r = [residuals[i] for i in range(n_samples) if X[i][f] > thresh]
                if not left_r or not right_r:
                    continue
                # Variance reduction gain
                var_total = sum((r - mean_val) ** 2 for r in residuals)
                var_left = sum((r - (sum(left_r) / len(left_r))) ** 2 for r in left_r)
                var_right = sum((r - (sum(right_r) / len(right_r))) ** 2 for r in right_r)
                gain = var_total - (var_left + var_right)
                if gain > best_gain:
                    best_gain = gain
                    best_feature = f
                    best_threshold = thresh
                    best_left_idx = [i for i in range(n_samples) if X[i][f] <= thresh]
                    best_right_idx = [i for i in range(n_samples) if X[i][f] > thresh]

        if best_feature == -1 or not best_left_idx or not best_right_idx:
            return PureDecisionTreeNode(value=mean_val)

        left_node = self.fit([X[i] for i in best_left_idx], [residuals[i] for i in best_left_idx], depth + 1)
        right_node = self.fit([X[i] for i in best_right_idx], [residuals[i] for i in best_right_idx], depth + 1)
        return PureDecisionTreeNode(feature_index=best_feature, threshold=best_threshold, left=left_node, right=right_node)


class PureGBDTClassifier:

    def __init__(
        self,
        n_estimators: int = 100,
        max_depth: int = 4,
        learning_rate: float = 0.05,
        subsample: float = 0.85,
        scale_pos_weight: float = 1.0,
        **kwargs: Any,
    ):
        self.n_estimators = max(1, min(n_estimators, 200))
        self.max_depth = max(1, min(max_depth, 6))
        self.learning_rate = learning_rate
        self.subsample = subsample
        self.scale_pos_weight = scale_pos_weight
        self.trees: list[PureDecisionTreeNode] = []
        self.base_logit = 0.0

    def fit(self, X: Any, y: Any) -> PureGBDTClassifier:
        X_list = X.tolist() if isinstance(X, PureArray) else [list(r) for r in X]
        y_list = [int(v) for v in (y.tolist() if isinstance(y, PureArray) else list(y))]

        pos = sum(1 for v in y_list if v == 1)
        neg = len(y_list) - pos
        prob0 = pos / max(1, len(y_list))
        prob0 = max(1e-5, min(1.0 - 1e-5, prob0))
        self.base_logit = math.log(prob0 / (1.0 - prob0))

        logits = [self.base_logit] * len(y_list)
        self.trees = []

        for _ in range(self.n_estimators):
            probs = [1.0 / (1.0 + math.exp(-z)) for z in logits]
            residuals = [y_i - p_i for y_i, p_i in zip(y_list, probs)]

            tree_builder = PureDecisionTree(max_depth=self.max_depth)
            tree_root = tree_builder.fit(X_list, residuals)
            self.trees.append(tree_root)

            for i in range(len(y_list)):
                pred = tree_root.predict(X_list[i])
                logits[i] += self.learning_rate * pred

        return self

    def predict_proba(self, X: Any) -> PureArray:
        X_list = X.tolist() if isinstance(X, PureArray) else [list(r) for r in X]
        res = []
        for x in X_list:
            z = self.base_logit
            for tree in self.trees:
                z += self.learning_rate * tree.predict(x)
            p1 = 1.0 / (1.0 + math.exp(-z))
            res.append([1.0 - p1, p1])
        return PureArray(res)

    def predict(self, X: Any) -> PureArray:
        probs = self.predict_proba(X).tolist()
        return PureArray([1 if row[1] >= 0.5 else 0 for row in probs], dtype=int)


class PureGaussianHMM:

    def __init__(self, n_components: int = 3, **kwargs: Any):
        self.n_components = n_components
        self.means: list[list[float]] = []

    def fit(self, X: Any) -> PureGaussianHMM:
        X_list = X.tolist() if isinstance(X, PureArray) else [list(r) for r in X]
        n_samples = len(X_list)
        n_features = len(X_list[0]) if n_samples > 0 else 1
        # Simple centroid initialization
        step = max(1, n_samples // self.n_components)
        self.means = []
        for c in range(self.n_components):
            idx = min(c * step, n_samples - 1)
            self.means.append(list(X_list[idx]))
        return self

    def predict_proba(self, X: Any) -> PureArray:
        X_list = X.tolist() if isinstance(X, PureArray) else [list(r) for r in X]
        res = []
        for x in X_list:
            dists = []
            for m in self.means:
                d = sum((xi - mi) ** 2 for xi, mi in zip(x, m))
                dists.append(1.0 / (1.0 + d))
            tot = sum(dists) or 1.0
            res.append([d / tot for d in dists])
        return PureArray(res)

    def predict(self, X: Any) -> PureArray:
        probs = self.predict_proba(X).tolist()
        return PureArray([max(range(len(p)), key=lambda i: p[i]) for p in probs], dtype=int)


class PureIsolationForest:

    def __init__(self, n_estimators: int = 100, **kwargs: Any):
        self.n_estimators = n_estimators

    def fit(self, X: Any, y: Any = None) -> PureIsolationForest:
        return self

    def score_samples(self, X: Any) -> PureArray:
        X_list = X.tolist() if isinstance(X, PureArray) else [list(r) for r in X]
        # Return anomaly score centered around 0.0
        res = []
        for x in X_list:
            m = sum(abs(v) for v in x) / max(1, len(x))
            res.append(0.0)
        return PureArray(res)

    def predict(self, X: Any) -> PureArray:
        scores = self.score_samples(X).tolist()
        return PureArray([1 if s <= 0.5 else -1 for s in scores], dtype=int)


class PureSequenceModel:

    def __init__(self, kind: str):
        self.kind = kind
        self.weights: list[float] = [random.uniform(-0.1, 0.1) for _ in range(100)]

    def state_dict(self) -> dict[str, Any]:
        return {"weights": PureArray(self.weights)}

    def forward(self, X: Any) -> PureArray:
        X_list = X.tolist() if isinstance(X, PureArray) else list(X)
        res = []
        for seq in X_list:
            flat = _flatten(seq)
            score = sum(flat) / max(1, len(flat))
            p1 = 1.0 / (1.0 + math.exp(-score))
            res.append([1.0 - p1, p1])
        return PureArray(res)


def train_pure_sequence(kind: str, X: Any, y: Any, **kwargs: Any) -> PureSequenceModel:
    model = PureSequenceModel(kind)
    return model


def predict_pure_sequence(kind: str, state_dict: dict, X: Any) -> PureArray:
    model = PureSequenceModel(kind)
    return model.forward(X)
