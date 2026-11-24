"""FastAPI app: a small, stateless JSON API. It holds no credentials.

- /api/spotify/*  reads public playlists and profiles the way Spotify's embed widget does (no Spotify login)
- /api/ytm/*      searches YouTube Music anonymously to match songs (and for searches the user types)
Writing playlists happens in the browser with the user's own Google sign-in.
Locally this app also serves ./public; on Vercel the CDN serves ./public.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import spotify_public, ytm
from .matcher import SpotifyTrack

ON_VERCEL = bool(os.environ.get("VERCEL"))
PUBLIC = Path(__file__).resolve().parent.parent / "public"

app = FastAPI(title="Dubdeck", docs_url=None, redoc_url=None, openapi_url=None)

if not ON_VERCEL:
    # Local server: block DNS-rebinding requests from other sites.
    _hosts = ["127.0.0.1", "localhost", "[::1]"] + [h for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_hosts)


@app.exception_handler(ytm.YTMError)
async def _ytm_err(_: Request, e: ytm.YTMError):
    return JSONResponse({"detail": str(e)}, status_code=e.status)


@app.exception_handler(spotify_public.SpotifyPublicError)
async def _sp_err(_: Request, e: spotify_public.SpotifyPublicError):
    return JSONResponse({"detail": str(e)}, status_code=e.status)


# ---------------------------------------------------------------- models


class SpotifyIdsIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=50)

    @field_validator("ids")
    @classmethod
    def _ids(cls, v: list[str]) -> list[str]:
        if not all(spotify_public.ID_RE.match(x) for x in v):
            raise ValueError("invalid Spotify track id")
        return v


class CollectionIn(BaseModel):
    kind: str = Field(pattern="^(playlist|album)$")
    id: str = Field(pattern=r"^[A-Za-z0-9]{22}$")


class UserIn(BaseModel):
    id: str = Field(pattern=r"^[^\s/?#:]{1,100}$")


class TrackIn(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    title: str = Field(min_length=1, max_length=500)
    artists: list[str] = Field(default_factory=list, max_length=30)
    album: str = Field(default="", max_length=500)
    duration_sec: float | None = None
    isrc: str | None = Field(default=None, max_length=20)


class MatchIn(BaseModel):
    tracks: list[TrackIn] = Field(min_length=1, max_length=12)
    region: str | None = Field(default=None, pattern="^[A-Za-z]{2}$")


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    track: TrackIn
    region: str | None = Field(default=None, pattern="^[A-Za-z]{2}$")


class LookupIn(BaseModel):
    url: str = Field(min_length=1, max_length=500)


# ---------------------------------------------------------------- api


@app.get("/api/config")
def config():
    return {"google_client_id": os.environ.get("GOOGLE_CLIENT_ID") or None}


@app.post("/api/spotify/tracks")
def spotify_tracks(body: SpotifyIdsIn):
    return {"tracks": spotify_public.tracks(body.ids)}


@app.post("/api/spotify/collection")
def spotify_collection(body: CollectionIn):
    return spotify_public.collection(body.kind, body.id)


@app.post("/api/spotify/user")
def spotify_user(body: UserIn):
    return spotify_public.user_playlists(body.id)


@app.post("/api/ytm/match")
def ytm_match(body: MatchIn):
    tracks = [SpotifyTrack(**t.model_dump()) for t in body.tracks]
    return {"results": ytm.match_many(tracks, region=body.region)}


@app.post("/api/ytm/search")
def ytm_search(body: SearchIn):
    track = SpotifyTrack(**body.track.model_dump())
    return {"candidates": ytm.search(body.query, track, region=body.region)}


@app.post("/api/ytm/lookup")
def ytm_lookup(body: LookupIn):
    return {"candidate": ytm.lookup(body.url)}


# ---------------------------------------------------------------- pages


@app.get("/", include_in_schema=False)
def index():
    page = PUBLIC / "index.html"
    if not page.exists():
        return JSONResponse({"detail": "Not found"}, status_code=404)
    return FileResponse(page, headers={"Cache-Control": "no-cache"})


if not ON_VERCEL:

    @app.middleware("http")
    async def _revalidate_static(request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"  # always pick up new versions after an update
        return response

    app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")
