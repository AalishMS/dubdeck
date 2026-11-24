"""Read Spotify songs without logging in, the way Spotify's own embed widget does.

Two layers, neither an official API, so either can change without notice:

1. The embed page (open.spotify.com/embed/...) says whether something is public and lists
   up to 100 songs, without ISRCs.
2. The embed page also carries a short-lived anonymous token, the one the widget itself
   uses. With it Spotify answers for whole playlists, song details in batches of 50 (with
   ISRC and album) and the public playlists on a profile. The batch endpoint has a daily
   quota for this token; when it runs out, song details come one at a time from the
   metadata endpoint the Spotify clients use, which has the same fields.

Layer 2 is an upgrade, never a requirement: when it fails, callers fall back to layer 1.
Private playlists and Liked Songs are out of reach for both.
"""

from __future__ import annotations

import html
import json
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests

ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")
_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
    "Accept-Language": "en",
}
PLAYLIST_EMBED_LIMIT = 100
MAX_PLAYLIST_TRACKS = 5000  # also YouTube's cap for one playlist
MAX_USER_PLAYLISTS = 500
_API = "https://api.spotify.com/v1"
_PLAYLIST_API = "https://spclient.wg.spotify.com/playlist/v2/playlist"
_METADATA_API = "https://spclient.wg.spotify.com/metadata/4/track"
_TOKEN_SEED = ("track", "4u7EnebtmKWzUH433cf5Qv")  # any public embed page hands out a token
_B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
_MAX_BLOCK = 6 * 3600  # never trust a Retry-After for longer than this


class SpotifyPublicError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class _Unavailable(Exception):
    """The anonymous-token route didn't answer. Callers fall back to the embed page."""


class _RateLimited(_Unavailable):
    """Spotify said 429 and asked us to wait longer than is worth waiting inside a request."""

    def __init__(self, retry_after: float):
        super().__init__(f"rate limited for {retry_after:.0f}s")
        self.retry_after = retry_after


class _LRU(OrderedDict):
    def __init__(self, size: int):
        super().__init__()
        self.size = size
        self.lock = threading.Lock()

    def get_(self, key):
        with self.lock:
            if key in self:
                self.move_to_end(key)
                return self[key]
        return None

    def put(self, key, value):
        with self.lock:
            self[key] = value
            self.move_to_end(key)
            while len(self) > self.size:
                self.popitem(last=False)


_track_cache = _LRU(5000)
_local = threading.local()
_token = {"value": None, "expires": 0.0}
_token_lock = threading.Lock()
_batch_blocked_until = {"tracks": 0.0, "metadata": 0.0}  # endpoints out of quota, skipped until then
_block_lock = threading.Lock()


def _session() -> requests.Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = _local.session = requests.Session()
        s.headers.update(_HEADERS)
    return s


# ---------------------------------------------------------------- layer 1: embed pages


def _embed_state(kind: str, id_: str) -> dict | None:
    """Fetch the embed page's state, or None if Spotify has nothing public for it."""
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = _session().get(f"https://open.spotify.com/embed/{kind}/{id_}", timeout=15)
        except requests.RequestException as e:
            last = e
            time.sleep(0.8 * (attempt + 1))
            continue
        if r.status_code == 404:
            return None
        if r.status_code == 429 or r.status_code >= 500:
            last = SpotifyPublicError(f"Spotify returned {r.status_code}", 503)
            time.sleep(1.5 * (attempt + 1))
            continue
        if r.status_code != 200:
            raise SpotifyPublicError(f"Spotify returned {r.status_code} for this {kind}.", 502)
        m = _NEXT_DATA_RE.search(r.text)
        if not m:
            raise SpotifyPublicError("Spotify's page format changed, so Dubdeck can't read it right now.", 502)
        data = json.loads(m.group(1))
        state = ((data.get("props") or {}).get("pageProps") or {}).get("state") or {}
        _remember_token(state)
        return state
    raise SpotifyPublicError(f"Spotify isn't responding right now ({last}). Try again in a minute.", 503)


def _entity(kind: str, id_: str) -> dict | None:
    """The embed page's data entity, or None if Spotify has nothing public for it."""
    state = _embed_state(kind, id_)
    return ((state or {}).get("data") or {}).get("entity")


def _split_artists(subtitle: str) -> list[str]:
    # embeds join artists with ",<nbsp>"; a plain comma belongs to a name ("Tyler, The Creator")
    return [a.strip() for a in (subtitle or "").split(", ") if a.strip()]


# ---------------------------------------------------------------- layer 2: the embed's anonymous token


def _remember_token(state: dict) -> None:
    session = (state.get("settings") or {}).get("session") or {}
    value, expires = session.get("accessToken"), session.get("accessTokenExpirationTimestampMs")
    if value and expires:
        with _token_lock:
            if expires / 1000 > _token["expires"]:
                _token.update(value=value, expires=expires / 1000)


def _anon_token(refresh: bool = False) -> str:
    with _token_lock:
        if refresh:
            _token.update(value=None, expires=0.0)
        elif _token["value"] and _token["expires"] - time.time() > 60:
            return _token["value"]
    try:
        _embed_state(*_TOKEN_SEED)
    except SpotifyPublicError as e:
        raise _Unavailable(str(e)) from e
    with _token_lock:
        if not _token["value"]:
            raise _Unavailable("no anonymous token on the embed page")
        return _token["value"]


def _api_get(url: str, params: dict | None = None) -> dict | None:
    """GET a Spotify JSON endpoint with the anonymous token. None means Spotify said 404."""
    refresh = False
    for attempt in range(3):
        token = _anon_token(refresh)
        refresh = False
        try:
            r = _session().get(
                url, params=params, timeout=15, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}
            )
        except requests.RequestException:
            time.sleep(0.6 * (attempt + 1))
            continue
        if r.status_code == 200:
            try:
                return r.json()
            except ValueError as e:
                raise _Unavailable("not JSON") from e
        if r.status_code == 404:
            return None
        if r.status_code == 401:
            refresh = True
            continue
        if r.status_code == 429:
            wait = r.headers.get("Retry-After", "")
            if wait.isdigit() and int(wait) <= 3:
                time.sleep(int(wait) + 0.2)
                continue
            raise _RateLimited(float(wait) if wait.isdigit() else 60.0)
        if r.status_code >= 500:
            time.sleep(0.6 * (attempt + 1))
            continue
        raise _Unavailable(f"HTTP {r.status_code}")
    raise _Unavailable("no answer")


def _clean(text: str | None) -> str:
    return html.unescape(_TAG_RE.sub("", text or "")).strip()


def _from_api(id_: str, t: dict) -> dict | None:
    if not t.get("name"):
        return None
    return {
        "id": id_,
        "title": t["name"],
        "artists": [a["name"] for a in t.get("artists") or [] if a.get("name")],
        "album": (t.get("album") or {}).get("name") or "",
        "duration_sec": (t.get("duration_ms") or 0) / 1000 or None,
        "isrc": ((t.get("external_ids") or {}).get("isrc") or "").upper() or None,
    }


def _gid(id_: str) -> str:
    """A base-62 Spotify id as the 32-digit hex id the metadata endpoint wants."""
    n = 0
    for c in id_:
        n = n * 62 + _B62.index(c)
    return f"{n:032x}"


def _from_metadata(id_: str, t: dict) -> dict | None:
    if not t.get("name"):
        return None
    isrc = next((x.get("id") for x in t.get("external_id") or [] if x.get("type") == "isrc"), None)
    return {
        "id": id_,
        "title": t["name"],
        "artists": [a["name"] for a in t.get("artist") or [] if a.get("name")],
        "album": (t.get("album") or {}).get("name") or "",
        "duration_sec": (t.get("duration") or 0) / 1000 or None,
        "isrc": (isrc or "").upper() or None,
    }


_NO_ANSWER = object()
METADATA_DEADLINE = 40.0  # seconds; past this the rest count as unanswered, so a request can't run on


def _metadata_track(id_: str):
    """One song from the metadata endpoint: a dict, or _NO_ANSWER.

    A 404 counts as no answer, not as "no such song": this endpoint is undocumented, so a miss
    here should fall back to the embed page rather than drop the song.
    """
    try:
        data = _api_get(f"{_METADATA_API}/{_gid(id_)}", {"market": "from_token"})
    except _RateLimited as e:
        _block("metadata", e.retry_after)
        return _NO_ANSWER
    except _Unavailable:
        return _NO_ANSWER
    return (_from_metadata(id_, data) if data else None) or _NO_ANSWER


def _block(name: str, retry_after: float) -> None:
    until = time.time() + min(retry_after, _MAX_BLOCK)
    with _block_lock:
        _batch_blocked_until[name] = max(_batch_blocked_until.get(name, 0.0), until)


def _batch_tracks(ids: list[str]) -> tuple[dict[str, dict], set[str]]:
    """Song details from /v1/tracks, 50 per request."""
    found: dict[str, dict] = {}
    unanswered: set[str] = set()
    if time.time() < _batch_blocked_until["tracks"]:
        return found, set(ids)
    chunks = [ids[i : i + 50] for i in range(0, len(ids), 50)]

    def one(chunk: list[str]) -> list | None:
        try:
            data = _api_get(f"{_API}/tracks", {"ids": ",".join(chunk)})
        except _RateLimited as e:
            _block("tracks", e.retry_after)
            return None
        except _Unavailable:
            return None
        rows = (data or {}).get("tracks")
        return rows if isinstance(rows, list) and len(rows) == len(chunk) else None

    with ThreadPoolExecutor(max_workers=min(4, len(chunks))) as pool:
        for chunk, rows in zip(chunks, pool.map(one, chunks)):
            if rows is None:
                unanswered.update(chunk)
                continue
            for id_, row in zip(chunk, rows):
                t = _from_api(id_, row) if row else None
                if t:
                    found[id_] = t
    return found, unanswered


def _api_tracks(ids: list[str], workers: int = 16) -> tuple[dict[str, dict], set[str]]:
    """Song details with ISRCs. Returns (found by id, ids Spotify gave no answer for).

    An id in neither is one Spotify answered with "no such song". Batches of 50 come first;
    whatever they didn't answer (usually because the token's daily quota for them is used up)
    is asked for one song at a time from the metadata endpoint.
    """
    unique = list(dict.fromkeys(ids))
    if not unique:
        return {}, set()
    found, unanswered = _batch_tracks(unique)
    rest = [i for i in unique if i in unanswered]
    if rest and time.time() >= _batch_blocked_until["metadata"]:
        unanswered = set()
        deadline = time.time() + METADATA_DEADLINE

        def one(id_: str):
            # Once Spotify rate-limits this endpoint too, or time runs out, stop asking.
            if time.time() > deadline or time.time() < _batch_blocked_until["metadata"]:
                return _NO_ANSWER
            return _metadata_track(id_)

        with ThreadPoolExecutor(max_workers=min(workers, len(rest))) as pool:
            for id_, t in zip(rest, pool.map(one, rest)):
                if t is _NO_ANSWER:
                    unanswered.add(id_)
                else:
                    found[id_] = t
    for id_, t in found.items():
        _track_cache.put(id_, t)
    return found, unanswered


def _playlist_full(id_: str) -> dict:
    """Every song id in a public playlist, in order, plus its description."""
    ids: list[str] = []
    seen = 0
    description = ""
    while True:
        data = _api_get(f"{_PLAYLIST_API}/{id_}", {"from": seen, "length": 1000} if seen else None)
        if not data:
            raise _Unavailable("playlist not served")
        if not seen:
            description = _clean((data.get("attributes") or {}).get("description"))
        items = (data.get("contents") or {}).get("items") or []
        seen += len(items)
        # local files and podcast episodes have other uri types
        ids += [it["uri"].rsplit(":", 1)[-1] for it in items if (it.get("uri") or "").startswith("spotify:track:")]
        if not items or seen >= (data.get("length") or 0) or len(ids) > MAX_PLAYLIST_TRACKS:
            break
    return {"ids": ids, "description": description}


# ---------------------------------------------------------------- what the API serves


def track(id_: str) -> dict | None:
    """One song from its embed page: the slow route, with no ISRC."""
    cached = _track_cache.get_(id_)
    if cached is not None:
        return cached
    e = _entity("track", id_)
    if not e:
        return None
    artists = [a.get("name") for a in e.get("artists") or [] if a.get("name")] or _split_artists(e.get("subtitle", ""))
    out = {
        "id": id_,
        "title": e.get("name") or e.get("title") or "",
        "artists": artists,
        "album": "",
        "duration_sec": (e.get("duration") or 0) / 1000 or None,
        "isrc": None,
    }
    if out["title"]:
        _track_cache.put(id_, out)
        return out
    return None


def tracks(ids: list[str], workers: int = 8) -> list[dict | None]:
    # Batches first: one request per 50 songs, and they come with ISRCs. A cached song without
    # an ISRC came from an embed page, so it's worth asking again.
    have = {i: c for i in ids if (c := _track_cache.get_(i)) and c.get("isrc")}
    found, unanswered = _api_tracks([i for i in ids if i not in have])
    have.update(found)

    def one(i: str) -> dict | None:
        try:
            return track(i)
        except SpotifyPublicError:
            return None

    # Only the songs Spotify didn't answer for go the slow way, one embed page each.
    slow = [i for i in dict.fromkeys(ids) if i in unanswered]
    if slow:
        with ThreadPoolExecutor(max_workers=min(workers, len(slow))) as pool:
            have.update({i: t for i, t in zip(slow, pool.map(one, slow)) if t})
    return [have.get(i) for i in ids]


def collection(kind: str, id_: str) -> dict:
    e = _entity(kind, id_)
    if not e:
        what = "playlist" if kind == "playlist" else "album"
        raise SpotifyPublicError(
            f"Spotify doesn't share this {what} publicly. If it's a private playlist, open it in the Spotify "
            "app, select all songs (Ctrl+A), copy them (Ctrl+C) and paste them here instead.",
            404,
        )
    items = e.get("trackList") or []
    album_name = e.get("name", "") if kind == "album" else ""
    from_embed: dict[str, dict] = {}
    ids: list[str] = []
    for it in items:
        uri = it.get("uri") or ""
        if not uri.startswith("spotify:track:") or not it.get("title"):
            continue  # podcast episodes, unavailable items
        tid = uri.rsplit(":", 1)[-1]
        ids.append(tid)
        from_embed[tid] = {
            "id": tid,
            "title": it["title"],
            "artists": _split_artists(it.get("subtitle", "")),
            "album": album_name,
            "duration_sec": (it.get("duration") or 0) / 1000 or None,
            "isrc": None,
        }

    # Upgrade from the embed's first 100 songs to the whole playlist, with ISRCs, when Spotify allows.
    truncated = kind == "playlist" and len(items) >= PLAYLIST_EMBED_LIMIT
    description = ""
    if kind == "playlist":
        try:
            full = _playlist_full(id_)
        except _Unavailable:
            full = None
        if full and full["ids"]:
            truncated = len(full["ids"]) > MAX_PLAYLIST_TRACKS
            ids = full["ids"][:MAX_PLAYLIST_TRACKS]
            description = full["description"]
    cached = {i: c for i in ids if (c := _track_cache.get_(i)) and c.get("isrc")}
    found, unanswered = _api_tracks([i for i in ids if i not in cached])
    found.update(cached)
    out_tracks = [t for t in (found.get(i) or from_embed.get(i) for i in ids) if t]
    if any(i in unanswered and i not in from_embed for i in ids):
        truncated = True  # these songs are in the playlist, but Spotify wouldn't describe them

    sources = (e.get("coverArt") or {}).get("sources") or []
    return {
        "kind": kind,
        "id": id_,
        "name": e.get("name") or e.get("title") or "Spotify playlist",
        "owner": e.get("subtitle") or "",
        "image": sources[0].get("url") if sources else None,
        "description": description,
        "tracks": out_tracks,
        "maybe_truncated": truncated,
    }


def user_playlists(user_id: str) -> dict:
    """The playlists a Spotify profile shows publicly. Their songs are read later, one playlist at a time."""
    who = quote(user_id, safe="")
    try:
        profile = _api_get(f"{_API}/users/{who}")
        if not profile:
            raise SpotifyPublicError(
                "Spotify has no profile at that link. Copy it again from your profile's Share menu.", 404
            )
        rows: list[dict] = []
        for offset in range(0, MAX_USER_PLAYLISTS, 50):
            page = _api_get(f"{_API}/users/{who}/playlists", {"limit": 50, "offset": offset}) or {}
            rows += [r for r in page.get("items") or [] if r and r.get("id")]
            if not page.get("next"):
                break
    except _Unavailable as e:
        raise SpotifyPublicError(
            "Spotify isn't listing profiles for Dubdeck right now. Paste the links of the playlists you want instead.",
            503,
        ) from e
    playlists = []
    for r in rows:
        images = r.get("images") or []
        playlists.append(
            {
                "id": r["id"],
                "name": r.get("name") or "Spotify playlist",
                "owner": (r.get("owner") or {}).get("display_name") or "",
                "image": images[0].get("url") if images else None,
                "description": _clean(r.get("description")),
                "count": (r.get("items") or r.get("tracks") or {}).get("total"),
            }
        )
    return {"id": user_id, "name": profile.get("display_name") or user_id, "playlists": playlists}
