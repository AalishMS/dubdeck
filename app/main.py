"""FastAPI app: a stateless JSON API for the YouTube Music side.

Spotify is handled entirely in the browser (PKCE). YouTube Music headers live in the
browser too and arrive with each request; nothing is stored here. Locally this app also
serves ./public; on Vercel the CDN serves ./public and this runs as one function.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import ytm
from .matcher import SpotifyTrack

ON_VERCEL = bool(os.environ.get("VERCEL"))
PUBLIC = Path(__file__).resolve().parent.parent / "public"
VIDEO_ID = r"^[A-Za-z0-9_-]{11}$"

app = FastAPI(title="Dubdeck", docs_url=None, redoc_url=None, openapi_url=None)

if not ON_VERCEL:
    # Local server: block DNS-rebinding requests from other sites.
    _hosts = ["127.0.0.1", "localhost", "[::1]"] + [h for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_hosts)


@app.exception_handler(ytm.YTMError)
async def _ytm_err(_: Request, e: ytm.YTMError):
    return JSONResponse({"detail": str(e)}, status_code=e.status)


# ---------------------------------------------------------------- models


class AuthBody(BaseModel):
    auth: dict[str, str]

    @field_validator("auth")
    @classmethod
    def _check_auth(cls, v: dict[str, str]) -> dict[str, str]:
        if not v or len(v) > 100 or sum(len(k) + len(x) for k, x in v.items()) > 60_000:
            raise ValueError("invalid YouTube Music headers")
        if "cookie" not in {k.lower() for k in v}:
            raise ValueError("YouTube Music headers are missing the cookie")
        return v


class ConnectIn(BaseModel):
    headers: str = Field(min_length=1, max_length=200_000)


class TrackIn(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    title: str = Field(min_length=1, max_length=500)
    artists: list[str] = Field(default_factory=list, max_length=30)
    album: str = Field(default="", max_length=500)
    duration_sec: float | None = None
    isrc: str | None = Field(default=None, max_length=20)


class MatchIn(AuthBody):
    tracks: list[TrackIn] = Field(min_length=1, max_length=12)


class LookupIn(AuthBody):
    url: str = Field(min_length=1, max_length=500)


class CreateIn(AuthBody):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=10_000)
    privacy: str = Field(default="PRIVATE", pattern="^(PRIVATE|UNLISTED|PUBLIC)$")


def _check_video_ids(v: list[str]) -> list[str]:
    if not all(re.match(VIDEO_ID, x) for x in v):
        raise ValueError("invalid video id")
    return v


class AddIn(AuthBody):
    playlist_id: str = Field(pattern=r"^[A-Za-z0-9_-]{2,64}$")
    video_ids: list[str] = Field(min_length=1, max_length=100)

    @field_validator("video_ids")
    @classmethod
    def _ids(cls, v: list[str]) -> list[str]:
        return _check_video_ids(v)


class LikeIn(AuthBody):
    video_ids: list[str] = Field(min_length=1, max_length=25)

    @field_validator("video_ids")
    @classmethod
    def _ids(cls, v: list[str]) -> list[str]:
        return _check_video_ids(v)


# ---------------------------------------------------------------- api


@app.get("/api/config")
def config():
    return {"spotify_client_id": os.environ.get("SPOTIFY_CLIENT_ID") or None}


@app.post("/api/ytm/connect")
def ytm_connect(body: ConnectIn):
    auth = ytm.parse_headers(body.headers)
    return {"auth": auth, "account": ytm.account(auth)}


@app.post("/api/ytm/match")
def ytm_match(body: MatchIn):
    tracks = [SpotifyTrack(**t.model_dump()) for t in body.tracks]
    return {"results": ytm.match_many(body.auth, tracks)}


@app.post("/api/ytm/lookup")
def ytm_lookup(body: LookupIn):
    return {"candidate": ytm.lookup(body.auth, body.url)}


@app.post("/api/ytm/create")
def ytm_create(body: CreateIn):
    return {"playlist_id": ytm.create_playlist(body.auth, body.title, body.description, body.privacy)}


@app.post("/api/ytm/add")
def ytm_add(body: AddIn):
    return {"failed": ytm.add_items(body.auth, body.playlist_id, body.video_ids)}


@app.post("/api/ytm/like")
def ytm_like(body: LikeIn):
    return {"failed": ytm.like(body.auth, body.video_ids)}


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
