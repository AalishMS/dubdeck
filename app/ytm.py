"""YouTube Music search and matching. Uses anonymous search only: no account, no
cookies. Writing playlists happens in the browser through Google's official API."""

from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from ytmusicapi import YTMusic
from ytmusicapi.constants import SUPPORTED_LOCATIONS

from .matcher import SpotifyTrack, confidence_label, score_candidate

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class YTMError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _retry(fn, *args, attempts: int = 3, **kwargs):
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # network hiccups / transient errors from YouTube Music
            last = e
            if i < attempts - 1:
                time.sleep(1.2 * (i + 1))
    raise YTMError(f"YouTube Music search failed: {last}", 502) from last


def client(region: str | None = None) -> YTMusic:
    region = (region or "").upper()
    return YTMusic(location=region) if region in SUPPORTED_LOCATIONS else YTMusic()


def _candidate(result: dict, score: float, method: str) -> dict:
    thumbs = result.get("thumbnails") or []
    album = result.get("album")
    return {
        "videoId": result["videoId"],
        "title": result.get("title") or "",
        "artists": ", ".join(a.get("name", "") for a in result.get("artists") or [] if a.get("name")),
        "album": album.get("name") if isinstance(album, dict) else None,
        "duration": result.get("duration_seconds"),
        "type": result.get("resultType") or "song",
        "thumbnail": thumbs[0]["url"] if thumbs else None,
        "score": score,
        "confidence": confidence_label(score),
        "method": method,
    }


def match_track(yt: YTMusic, track: SpotifyTrack) -> dict:
    cands: dict[str, dict] = {}

    def search(query: str, filter_: str) -> list[dict]:
        results = _retry(yt.search, query, filter=filter_, limit=10)
        return [r for r in results if r.get("videoId")]

    def consider(results: list[dict], method: str, top: int) -> None:
        for r in results[:top]:
            s = score_candidate(track, r)
            if method == "isrc" and s >= 0.55:
                s = round(min(1.0, s + 0.25), 3)  # exact recording ID hit
            prev = cands.get(r["videoId"])
            if not prev or prev["score"] < s:
                cands[r["videoId"]] = _candidate(r, s, method)

    def best() -> float:
        return max((c["score"] for c in cands.values()), default=0.0)

    if track.isrc:
        consider(search(track.isrc, "songs"), "isrc", 1)
    if best() < 0.85:
        consider(search(track.query(), "songs"), "search", 6)
    if best() < 0.8:
        consider(search(track.query(), "videos"), "search", 5)

    ranked = sorted(cands.values(), key=lambda c: c["score"], reverse=True)[:5]
    return {"match": ranked[0] if ranked else None, "candidates": ranked}


def match_many(tracks: list[SpotifyTrack], region: str | None = None, workers: int = 4) -> list[dict]:
    local = threading.local()

    def yt() -> YTMusic:
        if getattr(local, "yt", None) is None:
            local.yt = client(region)  # requests.Session isn't thread-safe: one per thread
        return local.yt

    def work(t: SpotifyTrack) -> dict:
        try:
            return {**match_track(yt(), t), "error": None}
        except YTMError as e:
            return {"match": None, "candidates": [], "error": str(e)}

    if not tracks:
        return []
    with ThreadPoolExecutor(max_workers=min(workers, len(tracks))) as pool:
        return list(pool.map(work, tracks))


def search(query: str, track: SpotifyTrack, region: str | None = None) -> list[dict]:
    """A search the user typed: songs first, then videos, in YouTube Music's own order.

    Each result is still scored against the Spotify song so the meter means the same thing
    everywhere, but nothing is re-ranked: the user asked for these words.
    """
    query = re.sub(r"\s+", " ", query or "").strip()
    if not query:
        raise YTMError("Type something to search for.")

    def run(filter_: str, top: int) -> list[dict]:
        found = _retry(client(region).search, query, filter=filter_, limit=10)
        return [r for r in found if r.get("videoId")][:top]

    with ThreadPoolExecutor(max_workers=2) as pool:  # one client per thread: sessions aren't thread-safe
        songs, videos = pool.map(lambda a: run(*a), [("songs", 6), ("videos", 4)])
    out: dict[str, dict] = {}
    for r in songs + videos:
        out.setdefault(r["videoId"], _candidate(r, score_candidate(track, r), "search"))
    return list(out.values())


def lookup(url_or_id: str) -> dict:
    """Resolve a pasted YouTube / YouTube Music link to a candidate."""
    s = (url_or_id or "").strip()
    m = re.search(r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})", s)
    vid = m.group(1) if m else s
    if not VIDEO_ID_RE.match(vid):
        raise YTMError("Paste a music.youtube.com or youtube.com link to a song or video.")
    info = _retry(client().get_song, vid)
    details = info.get("videoDetails") or {}
    if not details.get("videoId"):
        raise YTMError("Couldn't find that video.")
    thumbs = (details.get("thumbnail") or {}).get("thumbnails") or []
    return {
        "videoId": details["videoId"],
        "title": details.get("title") or vid,
        "artists": details.get("author") or "",
        "album": None,
        "duration": int(details.get("lengthSeconds") or 0) or None,
        "type": "manual",
        "thumbnail": thumbs[0]["url"] if thumbs else None,
        "score": 1.0,
        "confidence": "manual",
        "method": "manual",
    }
