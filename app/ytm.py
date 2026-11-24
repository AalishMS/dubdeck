"""YouTube Music side. Stateless: every call receives the user's browser headers and
nothing is stored on the server, so this works the same locally and on Vercel."""

from __future__ import annotations

import html
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ytmusicapi import YTMusic, setup
from ytmusicapi.models.content.enums import LikeStatus

from .matcher import SpotifyTrack, confidence_label, score_candidate

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class YTMError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


SIGNED_OUT = (
    "YouTube Music didn't accept your saved headers (they expire when you sign out of that browser). "
    "Disconnect and paste fresh ones."
)


_AUTH_FAIL_RE = re.compile(r"HTTP 40[13]\b|__Secure-3PAPISID|Please provide authentication")


def _is_auth_failure(e: Exception) -> bool:
    return bool(_AUTH_FAIL_RE.search(str(e)))


def _retry(fn, *args, attempts: int = 3, **kwargs):
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            if _is_auth_failure(e):
                raise YTMError(SIGNED_OUT, 401) from e
            last = e
            if i < attempts - 1:
                time.sleep(1.2 * (i + 1))
    raise YTMError(f"YouTube Music request failed: {last}", 502) from last


# ---------------------------------------------------------------- auth


def parse_headers(raw: str) -> dict[str, str]:
    """Turn pasted request headers into the dict ytmusicapi expects."""
    raw = (raw or "").strip().replace("\r\n", "\n")
    if not raw:
        raise YTMError("Paste the request headers first.")
    try:
        headers: dict[str, str] = json.loads(setup(headers_raw=raw))
    except Exception as e:
        raise YTMError(str(e)) from e
    keys = {k.lower() for k in headers}
    if "origin" not in keys and "x-origin" not in keys:
        headers["origin"] = "https://music.youtube.com"
    if "authorization" not in keys:
        # ytmusicapi recomputes this per request; the key just marks browser auth
        headers["authorization"] = "SAPISIDHASH 0"
    return headers


def client(auth: dict[str, str]) -> YTMusic:
    try:
        return YTMusic(auth=dict(auth))
    except Exception as e:
        raise YTMError(f"Those YouTube Music headers can't be used: {e}", 401) from e


def account(auth: dict[str, str]) -> dict:
    try:
        info = client(auth).get_account_info()
    except YTMError:
        raise
    except Exception as e:
        raise YTMError(
            "Those headers didn't work. Make sure you're signed in at music.youtube.com and copy the "
            f"headers from a fresh 'browse' request. ({type(e).__name__}: {e})",
            401,
        ) from e
    return {
        "name": info.get("accountName") or "YouTube Music",
        "handle": info.get("channelHandle"),
        "photo": info.get("accountPhotoUrl"),
    }


# ---------------------------------------------------------------- matching


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


def match_many(auth: dict[str, str], tracks: list[SpotifyTrack], workers: int = 4) -> list[dict]:
    local = threading.local()

    def yt() -> YTMusic:
        if getattr(local, "yt", None) is None:
            local.yt = client(auth)  # requests.Session isn't thread-safe: one per thread
        return local.yt

    def work(t: SpotifyTrack) -> dict:
        try:
            return {**match_track(yt(), t), "error": None}
        except YTMError as e:
            if e.status == 401:
                raise
            return {"match": None, "candidates": [], "error": str(e)}

    if not tracks:
        return []
    with ThreadPoolExecutor(max_workers=min(workers, len(tracks))) as pool:
        return list(pool.map(work, tracks))


def lookup(auth: dict[str, str], url_or_id: str) -> dict:
    """Resolve a pasted YouTube / YouTube Music link to a candidate."""
    s = (url_or_id or "").strip()
    m = re.search(r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})", s)
    vid = m.group(1) if m else s
    if not VIDEO_ID_RE.match(vid):
        raise YTMError("Paste a music.youtube.com or youtube.com link to a song or video.")
    info = _retry(client(auth).get_song, vid)
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


# ---------------------------------------------------------------- writes


def create_playlist(auth: dict[str, str], title: str, description: str, privacy: str) -> str:
    title = re.sub(r"[<>]", "", title).strip()[:150] or "Imported from Spotify"
    description = re.sub(r"[<>]", "", html.unescape(description or ""))[:4900]
    if privacy not in {"PRIVATE", "UNLISTED", "PUBLIC"}:
        privacy = "PRIVATE"
    res = _retry(client(auth).create_playlist, title, description, privacy_status=privacy)
    if not isinstance(res, str):
        raise YTMError(f"YouTube Music refused to create the playlist: {str(res)[:300]}", 502)
    return res


def add_items(auth: dict[str, str], playlist_id: str, video_ids: list[str]) -> list[str]:
    """Add a batch; if the batch fails, add one by one. Returns the IDs that failed."""
    yt = client(auth)

    def ok(res: Any) -> bool:
        return isinstance(res, dict) and "SUCCEEDED" in str(res.get("status", ""))

    try:
        if ok(_retry(yt.add_playlist_items, playlist_id, video_ids, duplicates=False)):
            return []
    except YTMError as e:
        if e.status == 401:
            raise
    failed = []
    for vid in video_ids:
        try:
            if not ok(_retry(yt.add_playlist_items, playlist_id, [vid], duplicates=False, attempts=2)):
                failed.append(vid)
        except YTMError as e:
            if e.status == 401:
                raise
            failed.append(vid)
    return failed


def like(auth: dict[str, str], video_ids: list[str]) -> list[str]:
    yt = client(auth)
    failed = []
    for vid in video_ids:
        try:
            _retry(yt.rate_song, vid, LikeStatus.LIKE, attempts=2)
        except YTMError as e:
            if e.status == 401:
                raise
            failed.append(vid)
    return failed
