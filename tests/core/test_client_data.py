from datetime import UTC, datetime

import httpx2
import pytest

from eufylife_mcp.core import (
    APIError,
    AuthenticationError,
    NetworkError,
    RateLimitError,
    ResponseShapeError,
)
from eufylife_mcp.core.client import APP_VERSION, EufyLifeClient
from tests.core.mock_api import MockAPI, fixture

LOGIN = "home-api.eufylife.com/v1/user/v2/email/login/"
DATA = "api.eufylife.com/v1/device/data"


async def logged_in(api: MockAPI) -> EufyLifeClient:
    api.on("POST", LOGIN, json_body=fixture("login_ok"))
    client = EufyLifeClient("me@example.com", "pw", transport=api.transport())
    await client.authenticate()
    return client


async def test_data_call_sends_token_headers():
    api = MockAPI()
    api.on("GET", DATA, json_body=fixture("device_data"))
    client = await logged_in(api)
    await client.measurements()
    await client.aclose()

    request = api.requests[-1]
    assert str(request.url) == f"https://{DATA}"
    assert request.headers["token"] == "token-abc"
    assert request.headers["uid"] == "user-0001"
    assert request.headers["user-agent"] == f"Eufylife-iOS-{APP_VERSION}-281"


async def test_after_is_sent_as_unix_seconds():
    api = MockAPI()
    api.on("GET", DATA, json_body=fixture("device_data"))
    client = await logged_in(api)
    await client.measurements(after=datetime(2026, 9, 1, tzinfo=UTC))
    assert api.requests[-1].url.params["after"] == "1788220800"


async def test_measurements_parse():
    api = MockAPI()
    api.on("GET", DATA, json_body=fixture("device_data"))
    client = await logged_in(api)
    ann, bob = await client.measurements()

    assert (ann.id, ann.customer_id) == ("rec-1", "cust-ann")
    assert ann.time == datetime(2026, 9, 25, 9, 0, tzinfo=UTC)
    assert (ann.scale_data.weight, ann.scale_data.body_fat) == (652, 27.4)
    assert (bob.scale_data.weight, bob.scale_data.bmi) == (815, 0)  # null bmi -> 0


async def test_missing_data_is_no_measurements():
    api = MockAPI()
    api.on("GET", DATA, json_body={"res_code": 1, "data": None})
    client = await logged_in(api)
    assert await client.measurements() == []


async def test_data_call_before_login_sends_nothing():
    api = MockAPI()
    client = EufyLifeClient("me@example.com", "pw", transport=api.transport())
    with pytest.raises(AuthenticationError):
        await client.measurements()
    assert api.requests == []


async def test_expired_token_401():
    api = MockAPI()
    api.on("GET", DATA, status=401, json_body={"message": "expired"})
    client = await logged_in(api)
    with pytest.raises(AuthenticationError):
        await client.measurements()


async def test_expired_token_in_body_is_authentication_error():
    # Observed live: a dead token gets HTTP 200 with a 401 in the body.
    api = MockAPI()
    body = {"code": 3158, "res_code": 401, "message": "Access token expired."}
    api.on("GET", DATA, json_body=body)
    client = await logged_in(api)
    with pytest.raises(AuthenticationError):
        await client.measurements()


async def test_rate_limited_data_call():
    api = MockAPI()
    api.on("GET", DATA, status=429, json_body={}, headers={"Retry-After": "12"})
    client = await logged_in(api)
    with pytest.raises(RateLimitError) as info:
        await client.measurements()
    assert info.value.retry_after == 12


async def test_server_error_data_call():
    api = MockAPI()
    api.on("GET", DATA, status=500, text="oops")
    client = await logged_in(api)
    with pytest.raises(APIError) as info:
        await client.measurements()
    assert info.value.status == 500


async def test_timeout_data_call():
    api = MockAPI()
    api.on("GET", DATA, raises=httpx2.ReadTimeout("slow"))
    client = await logged_in(api)
    with pytest.raises(NetworkError, match="ReadTimeout"):
        await client.measurements()


async def test_non_success_res_code_is_api_error():
    api = MockAPI()
    api.on("GET", DATA, json_body={"res_code": 26052, "message": "maintenance"})
    client = await logged_in(api)
    with pytest.raises(APIError) as info:
        await client.measurements()
    assert info.value.status == 26052


@pytest.mark.parametrize(
    "body",
    [
        {"res_code": 1, "data": [{"id": "r"}]},
        {"res_code": 1, "data": [{"id": "r", "customer_id": "c", "scale_data": {}}]},
        {"res_code": 1, "data": [{"id": "r", "customer_id": "c", "create_time": "yesterday"}]},
        {"res_code": 1, "data": {"not": "a list"}},
    ],
)
async def test_unexpected_shapes_name_the_call(body):
    api = MockAPI()
    api.on("GET", DATA, json_body=body)
    client = await logged_in(api)
    with pytest.raises(ResponseShapeError) as info:
        await client.measurements()
    assert info.value.call == "measurements"
