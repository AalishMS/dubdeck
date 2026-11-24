"""Read Spotify songs without logging in, from Spotify's public embed pages.

These are the pages behind Spotify's "Embed" widget. They need no account, but they're
not an official API, so the page format could change. Limits: playlist embeds list
the first 100 songs, and private playlists aren't available (song links still work).
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import requests

ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")
_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
    "Accept-Language": "en",
}
PLAYLIST_EMBED_LIMIT = 100


class SpotifyPublicError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


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


def _session() -> requests.Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = _local.session = requests.Session()
        s.headers.update(_HEADERS)
    return s


def _entity(kind: str, id_: str) -> dict | None:
    """Fetch the embed page's data entity, or None if Spotify has nothing public for it."""
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
        return (state.get("data") or {}).get("entity")
    raise SpotifyPublicError(f"Spotify isn't responding right now ({last}). Try again in a minute.", 503)


def _split_artists(subtitle: str) -> list[str]:
    # embeds join artists with ",<nbsp>"; a plain comma belongs to a name ("Tyler, The Creator")
    return [a.strip() for a in (subtitle or "").split(", ") if a.strip()]


def track(id_: str) -> dict | None:
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
    def one(i: str) -> dict | None:
        try:
            return track(i)
        except SpotifyPublicError:
            return None

    with ThreadPoolExecutor(max_workers=min(workers, len(ids) or 1)) as pool:
        return list(pool.map(one, ids))


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
    out_tracks = []
    for it in items:
        uri = it.get("uri") or ""
        if not uri.startswith("spotify:track:") or not it.get("title"):
            continue  # podcast episodes, unavailable items
        out_tracks.append(
            {
                "id": uri.rsplit(":", 1)[-1],
                "title": it["title"],
                "artists": _split_artists(it.get("subtitle", "")),
                "album": album_name,
                "duration_sec": (it.get("duration") or 0) / 1000 or None,
                "isrc": None,
            }
        )
    sources = (e.get("coverArt") or {}).get("sources") or []
    return {
        "kind": kind,
        "id": id_,
        "name": e.get("name") or e.get("title") or "Spotify playlist",
        "owner": e.get("subtitle") or "",
        "image": sources[0].get("url") if sources else None,
        "tracks": out_tracks,
        "maybe_truncated": kind == "playlist" and len(items) >= PLAYLIST_EMBED_LIMIT,
    }
