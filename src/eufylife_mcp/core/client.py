"""Async client for the EufyLife cloud API (login, member profiles, scale measurements)."""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import datetime
from typing import Any, TypeVar

import httpx2
from pydantic import TypeAdapter, ValidationError

from eufylife_mcp.core.exceptions import (
    APIError,
    AuthenticationError,
    LoginRejectedError,
    NetworkError,
    RateLimitError,
    ResponseShapeError,
)
from eufylife_mcp.core.models import Measurement, Member

AUTH_URL = "https://home-api.eufylife.com/v1/user/v2/email/login/"
DATA_URL = "https://api.eufylife.com/v1/device/data"

# The API only answers requests that look like the official app. Bump
# APP_VERSION when Eufy starts rejecting the current one.
APP_VERSION = "3.3.12"
CLIENT_ID = "eufy-app"
CLIENT_SECRET = "8FHf22gaTKu7MZXqz5zytw"

# `res_code` on success; anything else is a failure.
_OK = 1
# `res_code` the data API returns (with HTTP 200) when the token is no longer valid.
_EXPIRED = 401
# Log in again this long before the token's stated expiry.
_EXPIRY_MARGIN_S = 300
_DEFAULT_EXPIRES_IN_S = 30 * 24 * 3600

_MEMBERS = TypeAdapter(list[Member])
_MEASUREMENTS = TypeAdapter(list[Measurement])

T = TypeVar("T")


class EufyLifeClient:
    def __init__(
        self,
        email: str,
        password: str,
        country: str = "US",
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.country = country.upper()
        self._email = email
        self._password = password
        self._clock = clock
        self._token: str | None = None
        self._user_id: str | None = None
        self._expires_at = 0.0
        self._members: list[Member] = []
        self._http = httpx2.AsyncClient(transport=transport, timeout=timeout)

    async def __aenter__(self) -> EufyLifeClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def authenticate(self) -> None:
        """Log in; also refreshes the member list, which only the login response carries."""
        headers = {
            "accept": "*/*",
            "user-agent": f"EufyLife-Android-{APP_VERSION}",
            "category": "Health",
            "language": "en",
            "timezone": "UTC",
            "country": self.country,
            "content-type": "application/json",
        }
        body = {
            "client_id": CLIENT_ID,
            "client_Secret": CLIENT_SECRET,
            "email": self._email,
            "password": self._password,
            "ab": self.country.lower(),
            "un_subscribe_flag": True,
        }
        response = await self._send("POST", AUTH_URL, json=body, headers=headers)
        data = _json_object(response, "authenticate")
        code = data.get("res_code")
        if code != _OK:
            message = data.get("message")
            raise LoginRejectedError(
                code if isinstance(code, int) else 0, message if isinstance(message, str) else ""
            )

        token = data.get("access_token")
        user_id = data.get("user_id")
        if not isinstance(token, str) or not token or not isinstance(user_id, str) or not user_id:
            raise ResponseShapeError("authenticate")
        customers = data.get("customers")
        members = _parse(
            "authenticate", lambda: _MEMBERS.validate_python([] if customers is None else customers)
        )
        expires_in = data.get("expires_in")
        if not isinstance(expires_in, int) or expires_in <= 0:
            expires_in = _DEFAULT_EXPIRES_IN_S

        self._token = token
        self._user_id = user_id
        self._expires_at = self._clock() + expires_in
        self._members = members

    async def get_members(self) -> list[Member]:
        self._require_login()
        return list(self._members)

    async def measurements(self, after: datetime | None = None) -> list[Measurement]:
        """Every weigh-in on the account, or only those after `after`."""
        self._require_login()
        params = None if after is None else {"after": str(int(after.timestamp()))}
        headers = {
            "accept": "*/*",
            "uid": self._user_id or "",
            "token": self._token or "",
            "user-agent": f"Eufylife-iOS-{APP_VERSION}-281",
            "accept-language": "en-US,en;q=0.9",
        }
        response = await self._send("GET", DATA_URL, params=params, headers=headers)
        body = _json_object(response, "measurements")
        code = body.get("res_code")
        if code == _EXPIRED:
            # The API answers HTTP 200 with res_code 401 ("Access token expired.") once the
            # token dies; treat it like an HTTP 401 so the caller logs in again.
            raise AuthenticationError("EufyLife session token expired")
        if code != _OK:
            raise APIError(code if isinstance(code, int) else 0)
        records = body.get("data")
        if records is None:
            return []
        return _parse("measurements", lambda: _MEASUREMENTS.validate_python(records))

    def _require_login(self) -> None:
        if self._token is None:
            raise AuthenticationError("Not logged in")
        if self._clock() >= self._expires_at - _EXPIRY_MARGIN_S:
            raise AuthenticationError("EufyLife session expired")

    async def _send(
        self,
        method: str,
        url: str,
        *,
        json: Any = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx2.Response:
        try:
            response = await self._http.request(
                method, url, json=json, params=params, headers=headers
            )
        except httpx2.TransportError as exc:
            raise NetworkError(type(exc).__name__) from exc
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After", "")
            raise RateLimitError(int(retry_after) if retry_after.isdigit() else None)
        if response.status_code == 401:
            raise AuthenticationError("EufyLife returned HTTP 401")
        if not response.is_success:
            raise APIError(response.status_code)
        return response


def _json_object(response: httpx2.Response, call: str) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        raise ResponseShapeError(call) from None
    if not isinstance(body, dict):
        raise ResponseShapeError(call)
    return body


def _parse(call: str, build: Callable[[], T]) -> T:
    try:
        return build()
    except (ValidationError, KeyError, TypeError):
        raise ResponseShapeError(call) from None
