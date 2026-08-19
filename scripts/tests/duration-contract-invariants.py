import sys
from pathlib import Path

_ROOT_DIR = str(Path(__file__).resolve().parent.parent.parent)
_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent)
for p in (_ROOT_DIR, _SCRIPTS_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

try:
    from scripts.ml_ensemble_runtime import _require_request_duration
except ImportError:
    from ml_ensemble_runtime import _require_request_duration


def test_request_duration_is_required():
    try:
        _require_request_duration({})
    except ValueError as exc:
        assert str(exc) == "DURATION_METADATA_REQUIRED"
    else:
        raise AssertionError("missing duration must be rejected")


def test_request_duration_is_not_replaced_by_default():
    value, unit = _require_request_duration({"durationValue": 17, "durationUnit": "t"})
    assert value == 17
    assert unit == "t"


def test_request_duration_rejects_invalid_values():
    for request in (
        {"durationValue": 0, "durationUnit": "t"},
        {"durationValue": -1, "durationUnit": "t"},
        {"durationValue": 5, "durationUnit": ""},
        {"durationValue": "not-a-number", "durationUnit": "t"},
    ):
        try:
            _require_request_duration(request)
        except ValueError as exc:
            assert str(exc) == "DURATION_METADATA_REQUIRED"
        else:
            raise AssertionError(f"invalid duration accepted: {request}")


if __name__ == "__main__":
    test_request_duration_is_required()
    test_request_duration_is_not_replaced_by_default()
    test_request_duration_rejects_invalid_values()
    print("ALL DURATION CONTRACT INVARIANTS PASSED.")
