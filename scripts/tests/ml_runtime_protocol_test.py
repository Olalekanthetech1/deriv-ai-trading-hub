import json


def attach_request_context(output: dict, request: dict) -> dict:
    next_output = dict(output)
    if "id" not in next_output:
        next_output["id"] = request.get("id")
    return next_output


def test_terminal_result_contains_request_id():
    request = {"id": "req_123", "action": "train_partitioned"}
    output = attach_request_context({"success": True, "modelId": "demo"}, request)
    assert output["id"] == "req_123"


def test_existing_id_is_not_overwritten():
    request = {"id": "req_123", "action": "ping"}
    output = attach_request_context({"success": True, "id": "server-id"}, request)
    assert output["id"] == "server-id"


def test_terminal_result_is_json_serializable():
    request = {"id": "req_123", "action": "train_partitioned"}
    output = attach_request_context({"success": True, "metrics": {"accuracy": 0.5}}, request)
    json.dumps(output)
