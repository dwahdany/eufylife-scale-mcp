"""ScaleService: member lookup, lazy login and error mapping over the EufyLife client."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Protocol, TypeVar

from mcp.server.mcpserver.exceptions import ToolError

from eufylife_mcp import tracing
from eufylife_mcp.core import (
    APIError,
    AuthenticationError,
    LoginRejectedError,
    Measurement,
    Member,
    NetworkError,
    RateLimitError,
    ResponseShapeError,
)

T = TypeVar("T")

# `list_members` logs in again to refresh its answer once the cached list is this old.
# Members only come with the login response, and the Desktop client keeps this
# process alive for days, so without this a profile added or removed in the app
# would never show up.
MEMBER_LIST_MAX_AGE = timedelta(minutes=5)


class EufyClient(Protocol):
    """The subset of core.client.EufyLifeClient that ScaleService uses."""

    async def authenticate(self) -> None: ...
    async def get_members(self) -> list[Member]: ...
    async def measurements(self, after: datetime | None = None) -> list[Measurement]: ...


class UnknownMemberError(ToolError):
    """No member profile matches the requested identifier."""


def _describe(members: list[Member]) -> str:
    if not members:
        return "none"
    return ", ".join(f"{m.name} ({m.id})" for m in members)


def resolve_member(members: list[Member], identifier: str | None) -> Member:
    """Pick the member named by `identifier` (id or name).

    None means the only member, or else the account's default (owner) member.
    """
    text = " ".join((identifier or "").split())
    if not text:
        if len(members) == 1:
            return members[0]
        if not members:
            raise ToolError("This EufyLife account has no member profiles.")
        defaults = [m for m in members if m.is_default]
        if len(defaults) == 1:
            return defaults[0]
        raise ToolError(
            "This account has several members; pass `member` as one of: " + _describe(members)
        )

    key = text.casefold()
    matches = [m for m in members if m.id.casefold() == key]
    if not matches:
        matches = [m for m in members if " ".join(m.name.split()).casefold() == key]
    if not matches:
        matches = [m for m in members if (m.name.split() or [""])[0].casefold() == key]

    if len(matches) == 1:
        return matches[0]
    if matches:
        raise ToolError(
            f"Member {text!r} is ambiguous; pass the member_id of one of: {_describe(matches)}"
        )
    raise UnknownMemberError(
        f"No member matches {text!r}. Members on this account: {_describe(members)}"
    )


def _to_tool_error(exc: Exception) -> ToolError | None:
    """Translate an EufyLife client error into a user-facing ToolError."""
    if isinstance(exc, LoginRejectedError):
        return ToolError(f"{exc}. Check EUFYLIFE_EMAIL and EUFYLIFE_PASSWORD.")
    if isinstance(exc, AuthenticationError):
        return ToolError("EufyLife login failed. Check EUFYLIFE_EMAIL and EUFYLIFE_PASSWORD.")
    if isinstance(exc, RateLimitError):
        wait = f"in {exc.retry_after} seconds" if exc.retry_after is not None else "later"
        return ToolError(f"Rate limited by EufyLife. Try again {wait}.")
    if isinstance(exc, APIError):
        return ToolError(f"EufyLife API error {exc.status}.")
    if isinstance(exc, NetworkError):
        return ToolError(f"Could not reach EufyLife: {exc.kind}.")
    if isinstance(exc, ResponseShapeError):
        return ToolError(f"EufyLife returned unexpected data for {exc.call}.")
    return None


class ScaleService:
    """Lazy login, re-login on expiry, and member lookup over an EufyLife client."""

    def __init__(
        self, client: EufyClient, *, clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    ) -> None:
        self._client = client
        self._clock = clock
        self._auth_lock = asyncio.Lock()
        self._members_lock = asyncio.Lock()
        self._authenticated = False
        self._members: list[Member] | None = None
        self._members_fetched_at: datetime | None = None

    async def list_members(self) -> list[Member]:
        return await self._member_list(refresh=self._members_stale())

    def _members_stale(self) -> bool:
        fetched_at = self._members_fetched_at
        return fetched_at is not None and self._clock() - fetched_at >= MEMBER_LIST_MAX_AGE

    async def latest(self, member: str | None) -> tuple[Member, Measurement]:
        resolved = await self._resolve(member)
        records = await self._request("measurements", self._client.measurements, resolved)
        own = [m for m in records if m.customer_id == resolved.id]
        if not own:
            raise ToolError(f"No scale measurements recorded for {resolved.name}.")
        return resolved, max(own, key=lambda m: m.time)

    async def history(self, member: str | None, days: int) -> tuple[Member, list[Measurement]]:
        resolved = await self._resolve(member)
        after = self._clock() - timedelta(days=days)
        records = await self._request("measurements", self._client.measurements, resolved, after)
        return resolved, [m for m in records if m.customer_id == resolved.id and m.time > after]

    async def _resolve(self, identifier: str | None) -> Member:
        try:
            return resolve_member(await self._member_list(refresh=False), identifier)
        except UnknownMemberError:
            # A member may have been added in the app since the list was cached.
            return resolve_member(await self._member_list(refresh=True), identifier)

    async def _member_list(self, *, refresh: bool) -> list[Member]:
        async with self._members_lock:
            if self._members is None or refresh:
                if refresh:
                    # Members only come with the login response, so refreshing means logging in.
                    async with self._mapped_errors("authenticate", None):
                        await self._authenticate(force=True)
                self._members = await self._request("get_members", self._client.get_members)
                self._members_fetched_at = self._clock()
            return self._members

    async def _authenticate(self, *, force: bool) -> None:
        async with self._auth_lock:
            if self._authenticated and not force:
                return
            self._authenticated = False
            await self._client.authenticate()
            self._authenticated = True
            if force:
                # The login response carries the current member list; drop ours so the
                # next lookup re-reads it from the client.
                self._members = None

    async def _request(
        self,
        method: str,
        fn: Callable[..., Awaitable[T]],
        member: Member | None = None,
        *args: object,
    ) -> T:
        async with self._mapped_errors(method, member):
            return await self._call_with_reauth(fn, *args)

    @asynccontextmanager
    async def _mapped_errors(self, method: str, member: Member | None) -> AsyncIterator[None]:
        """Trace one upstream call and turn client errors into ToolErrors."""
        metadata = None if member is None else {"member_id": member.id}
        async with tracing.span(f"eufylife.{method}", metadata):
            try:
                yield
            except Exception as exc:
                tool_error = _to_tool_error(exc)
                if tool_error is None:
                    raise
                raise tool_error from exc

    async def _call_with_reauth(self, fn: Callable[..., Awaitable[T]], *args: object) -> T:
        await self._authenticate(force=False)
        try:
            return await fn(*args)
        except AuthenticationError:
            pass  # token expired: log in again and retry once
        await self._authenticate(force=True)
        return await fn(*args)
