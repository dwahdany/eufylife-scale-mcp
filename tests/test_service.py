import asyncio
from datetime import timedelta

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from eufylife_mcp.core import (
    APIError,
    AuthenticationError,
    LoginRejectedError,
    NetworkError,
    RateLimitError,
    ResponseShapeError,
)
from eufylife_mcp.service import MEMBER_LIST_MAX_AGE, ScaleService
from tests.factories import ANN, ANN_SMITH, BOB
from tests.fakes import NOW, FakeEufyClient


def service_for(client: FakeEufyClient) -> ScaleService:
    return ScaleService(client, clock=lambda: NOW)


async def test_lazy_login_happens_once_across_calls():
    client = FakeEufyClient([ANN, BOB])
    service = service_for(client)
    assert client.calls == []

    await service.list_members()
    await service.latest(None)
    await service.history(None, 30)

    assert client.count("authenticate") == 1
    assert client.calls[0] == ("authenticate", None)


async def test_concurrent_first_calls_share_one_login():
    client = FakeEufyClient([ANN], auth_delay=0.05)
    service = service_for(client)

    await asyncio.gather(service.latest(None), service.history(None, 7), service.list_members())

    assert client.count("authenticate") == 1
    assert client.count("get_members") == 1


async def test_latest_is_newest_measurement_of_that_member():
    service = service_for(FakeEufyClient([ANN, BOB]))
    member, measurement = await service.latest(None)  # Ann is the default member
    assert member is ANN
    assert measurement.id == "a3"

    member, measurement = await service.latest("Bob")
    assert (member, measurement.id) == (BOB, "b1")


async def test_latest_without_measurements_errors():
    service = service_for(FakeEufyClient([ANN, ANN_SMITH]))
    with pytest.raises(ToolError, match="No scale measurements recorded for Ann Smith"):
        await service.latest("Ann Smith")


async def test_history_asks_the_api_for_the_window_and_keeps_one_member():
    client = FakeEufyClient([ANN, BOB])
    service = service_for(client)

    member, measurements = await service.history("Ann", 30)

    assert member is ANN
    assert sorted(m.id for m in measurements) == ["a2", "a3"]
    assert ("measurements", NOW - timedelta(days=30)) in client.calls


async def test_history_filters_window_even_if_api_ignores_after():
    client = FakeEufyClient([ANN])

    async def ignore_after(after=None):
        return list(client.records)

    client.measurements = ignore_after
    _, measurements = await service_for(client).history(None, 30)
    assert "a1" not in {m.id for m in measurements}


async def test_member_list_is_cached():
    client = FakeEufyClient([ANN, BOB])
    service = service_for(client)
    await service.latest(None)
    await service.history("Bob", 7)
    assert client.count("get_members") == 1


async def test_unknown_member_logs_in_again_to_refresh_list():
    client = FakeEufyClient([ANN])
    service = service_for(client)
    await service.list_members()

    client.members.append(BOB)  # Bob was added in the app
    member, _ = await service.latest("Bob")

    assert member is BOB
    assert client.count("get_members") == 2
    assert client.count("authenticate") == 2


async def test_list_members_refreshes_once_the_cached_list_is_old():
    client = FakeEufyClient([ANN, BOB])
    now = NOW
    service = ScaleService(client, clock=lambda: now)

    assert await service.list_members() == [ANN, BOB]
    client.members.append(ANN_SMITH)  # added in the app
    client.members.remove(BOB)  # removed in the app

    now = NOW + MEMBER_LIST_MAX_AGE - timedelta(seconds=1)
    assert await service.list_members() == [ANN, BOB]  # still fresh enough: no login
    assert client.count("authenticate") == 1

    now = NOW + MEMBER_LIST_MAX_AGE
    assert await service.list_members() == [ANN, ANN_SMITH]
    assert client.count("authenticate") == 2
    assert client.count("get_members") == 2

    with pytest.raises(ToolError, match="No member matches 'Bob'"):
        await service.latest("Bob")


async def test_measurement_tools_keep_using_the_cached_list_within_max_age():
    client = FakeEufyClient([ANN, BOB])
    now = NOW
    service = ScaleService(client, clock=lambda: now)
    await service.list_members()

    now = NOW + MEMBER_LIST_MAX_AGE * 10
    await service.latest("Bob")
    await service.history(None, 7)
    assert client.count("authenticate") == 1
    assert client.count("get_members") == 1


async def test_relogin_after_expired_session_also_refreshes_members():
    client = FakeEufyClient([ANN, BOB])
    service = service_for(client)
    assert await service.list_members() == [ANN, BOB]

    client.members.remove(BOB)  # removed in the app
    client.fail_next["measurements"] = [AuthenticationError("EufyLife returned HTTP 401")]
    await service.history(None, 30)

    assert client.count("authenticate") == 2
    assert await service.list_members() == [ANN]
    assert client.count("authenticate") == 2  # the re-login was enough


async def test_unknown_member_after_refresh_errors():
    client = FakeEufyClient([ANN])
    service = service_for(client)
    with pytest.raises(ToolError, match="No member matches 'Zed'"):
        await service.latest("Zed")
    assert client.count("get_members") == 2


async def test_expired_session_reauthenticates_and_retries():
    client = FakeEufyClient([ANN])
    service = service_for(client)
    await service.list_members()

    client.fail_next["measurements"] = [AuthenticationError("EufyLife returned HTTP 401")]
    _, measurements = await service.history(None, 30)

    assert len(measurements) == 2
    assert client.count("authenticate") == 2
    assert client.count("measurements") == 2


async def test_second_auth_failure_is_surfaced():
    client = FakeEufyClient([ANN])
    service = service_for(client)
    await service.list_members()

    client.fail_next["measurements"] = [AuthenticationError("401"), AuthenticationError("401")]
    with pytest.raises(ToolError, match="EufyLife login failed"):
        await service.latest(None)
    assert client.count("authenticate") == 2


async def test_rejected_login_message_and_later_retry_logs_in_again():
    client = FakeEufyClient([ANN])
    service = service_for(client)
    client.fail_next["authenticate"] = [LoginRejectedError(5002, "Incorrect password")]

    with pytest.raises(ToolError) as info:
        await service.list_members()
    assert "code 5002: Incorrect password" in str(info.value)
    assert "Check EUFYLIFE_EMAIL and EUFYLIFE_PASSWORD" in str(info.value)

    await service.list_members()  # credentials fixed / transient failure gone
    assert client.count("authenticate") == 2


async def test_rejected_login_during_refresh_is_mapped():
    client = FakeEufyClient([ANN])
    service = service_for(client)
    await service.list_members()

    client.fail_next["authenticate"] = [LoginRejectedError(5002)]
    with pytest.raises(ToolError, match="rejected the login"):
        await service.latest("Zed")


@pytest.mark.parametrize(
    "error, message",
    [
        (RateLimitError(30), "Try again in 30 seconds."),
        (RateLimitError(None), "Try again later."),
        (APIError(500), "EufyLife API error 500."),
        (APIError(26052), "EufyLife API error 26052."),
        (NetworkError("ConnectError"), "Could not reach EufyLife: ConnectError."),
        (NetworkError("ReadTimeout"), "Could not reach EufyLife: ReadTimeout."),
        (ResponseShapeError("measurements"), "EufyLife returned unexpected data for measurements."),
    ],
)
async def test_data_call_errors_are_mapped(error, message):
    client = FakeEufyClient([ANN])
    client.fail_next["measurements"] = [error]
    with pytest.raises(ToolError) as info:
        await service_for(client).latest(None)
    assert str(info.value).endswith(message)
    assert info.value.__cause__ is error


async def test_unexpected_errors_propagate_unchanged():
    client = FakeEufyClient([ANN])
    client.fail_next["measurements"] = [KeyError("data")]
    with pytest.raises(KeyError):
        await service_for(client).latest(None)
