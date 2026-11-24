import pytest
from fastapi.testclient import TestClient

from app import main, ytm

AUTH = {"cookie": "SAPISID=x; __Secure-3PAPISID=x", "x-goog-authuser": "0", "authorization": "SAPISIDHASH 0"}


@pytest.fixture
def client():
    return TestClient(main.app, base_url="http://127.0.0.1")


def test_serves_the_app_locally(client):
    r = client.get("/")
    assert r.status_code == 200 and "Dubdeck" in r.text
    assert client.get("/app.js").status_code == 200
    assert client.get("/callback.html").status_code == 200


def test_rejects_other_hosts():
    r = TestClient(main.app, base_url="http://evil.example").get("/api/config")
    assert r.status_code == 400


def test_config_reads_env(client, monkeypatch):
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "abc123")
    assert client.get("/api/config").json() == {"spotify_client_id": "abc123"}
    monkeypatch.delenv("SPOTIFY_CLIENT_ID")
    assert client.get("/api/config").json() == {"spotify_client_id": None}


def test_connect_explains_bad_headers(client):
    r = client.post("/api/ytm/connect", json={"headers": "accept: */*\nuser-agent: x"})
    assert r.status_code == 400
    assert "cookie" in r.json()["detail"]


def test_parse_headers_fills_origin_and_authorization():
    h = ytm.parse_headers("cookie: SAPISID=abc; __Secure-3PAPISID=abc\nx-goog-authuser: 0\nuser-agent: test")
    assert h["origin"] == "https://music.youtube.com"
    assert h["authorization"].startswith("SAPISIDHASH")


def test_match_validates_input(client):
    track = {"title": "Song", "artists": ["A"]}
    assert client.post("/api/ytm/match", json={"auth": {"x": "y"}, "tracks": [track]}).status_code == 422
    assert client.post("/api/ytm/match", json={"auth": AUTH, "tracks": [track] * 13}).status_code == 422
    assert client.post("/api/ytm/match", json={"auth": AUTH, "tracks": []}).status_code == 422


def test_match_passes_tracks_through(client, monkeypatch):
    seen = {}

    def fake(auth, tracks):
        seen["auth"], seen["tracks"] = auth, tracks
        return [{"match": None, "candidates": [], "error": None} for _ in tracks]

    monkeypatch.setattr(ytm, "match_many", fake)
    body = {"auth": AUTH, "tracks": [{"id": "1", "title": "Song", "artists": ["A"], "duration_sec": 200, "isrc": "X"}]}
    r = client.post("/api/ytm/match", json=body)
    assert r.status_code == 200 and len(r.json()["results"]) == 1
    assert seen["auth"] == AUTH and seen["tracks"][0].isrc == "X"


def test_signed_out_maps_to_401(client, monkeypatch):
    def boom(*a, **k):
        raise ytm.YTMError(ytm.SIGNED_OUT, 401)

    monkeypatch.setattr(ytm, "create_playlist", boom)
    r = client.post("/api/ytm/create", json={"auth": AUTH, "title": "Mix"})
    assert r.status_code == 401 and "fresh" in r.json()["detail"]


def test_add_rejects_bad_ids(client):
    r = client.post("/api/ytm/add", json={"auth": AUTH, "playlist_id": "PL123", "video_ids": ["not a video id"]})
    assert r.status_code == 422
    r = client.post("/api/ytm/like", json={"auth": AUTH, "video_ids": ["bad"]})
    assert r.status_code == 422


def test_auth_failure_detection():
    assert ytm._is_auth_failure(Exception("Server returned HTTP 401: Unauthorized."))
    assert not ytm._is_auth_failure(Exception("video abc401def failed"))
