import pytest
from fastapi.testclient import TestClient

from app import main, spotify_public, ytm


@pytest.fixture
def client():
    return TestClient(main.app, base_url="http://127.0.0.1")


def test_serves_the_app_locally(client):
    r = client.get("/")
    assert r.status_code == 200 and "Dubdeck" in r.text
    assert client.get("/app.js").status_code == 200
    assert client.get("/styles.css").status_code == 200


def test_rejects_other_hosts():
    assert TestClient(main.app, base_url="http://evil.example").get("/api/config").status_code == 400


def test_config_reads_env(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com")
    assert client.get("/api/config").json() == {"google_client_id": "123-abc.apps.googleusercontent.com"}
    monkeypatch.delenv("GOOGLE_CLIENT_ID")
    assert client.get("/api/config").json() == {"google_client_id": None}


# ---------------------------------------------------------------- spotify (public embeds)

TRACK_ENTITY = {"name": "Mr. Brightside", "artists": [{"name": "The Killers"}], "duration": 222973}
PLAYLIST_ENTITY = {
    "name": "Road trip",
    "subtitle": "Aalish",
    "coverArt": {"sources": [{"url": "https://i.scdn.co/image/x"}]},
    "trackList": [
        {"uri": "spotify:track:003vvx7Niy0yvhvHt4a68B", "title": "Mr. Brightside", "subtitle": "The Killers", "duration": 222973},
        {"uri": "spotify:track:7ouMYWpwJ422jRcDASZB7P", "title": "Hey", "subtitle": "Tyler, The Creator, Kali Uchis", "duration": 200000},
        {"uri": "spotify:episode:5Xt5DXGzch68nYYamXrNxZ", "title": "A podcast", "subtitle": "Show"},
    ],
}


def test_tracks_endpoint(client, monkeypatch):
    spotify_public._track_cache.clear()
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: TRACK_ENTITY if i.startswith("003") else None)
    r = client.post("/api/spotify/tracks", json={"ids": ["003vvx7Niy0yvhvHt4a68B", "0000000000000000000000"]})
    assert r.status_code == 200
    first, second = r.json()["tracks"]
    assert first == {"id": "003vvx7Niy0yvhvHt4a68B", "title": "Mr. Brightside", "artists": ["The Killers"], "album": "", "duration_sec": 222.973, "isrc": None}
    assert second is None


def test_tracks_validates_ids(client):
    assert client.post("/api/spotify/tracks", json={"ids": ["not-an-id"]}).status_code == 422
    assert client.post("/api/spotify/tracks", json={"ids": ["003vvx7Niy0yvhvHt4a68B"] * 51}).status_code == 422


def test_collection_splits_artists_and_skips_episodes(client, monkeypatch):
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: PLAYLIST_ENTITY)
    r = client.post("/api/spotify/collection", json={"kind": "playlist", "id": "37i9dQZF1DX4UtSsGT1Sbe"})
    body = r.json()
    assert r.status_code == 200 and body["name"] == "Road trip" and body["image"] == "https://i.scdn.co/image/x"
    assert [t["title"] for t in body["tracks"]] == ["Mr. Brightside", "Hey"]
    assert body["tracks"][1]["artists"] == ["Tyler, The Creator", "Kali Uchis"]
    assert body["maybe_truncated"] is False


def test_private_playlist_explains_what_to_do(client, monkeypatch):
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: None)
    r = client.post("/api/spotify/collection", json={"kind": "playlist", "id": "37i9dQZF1DX4UtSsGT1Sbe"})
    assert r.status_code == 404 and "Ctrl+A" in r.json()["detail"]


# ---------------------------------------------------------------- youtube music (anonymous search)


def test_match_validates_input(client):
    track = {"title": "Song", "artists": ["A"]}
    assert client.post("/api/ytm/match", json={"tracks": [track] * 13}).status_code == 422
    assert client.post("/api/ytm/match", json={"tracks": []}).status_code == 422
    assert client.post("/api/ytm/match", json={"tracks": [track], "region": "USA"}).status_code == 422


def test_match_passes_tracks_and_region(client, monkeypatch):
    seen = {}

    def fake(tracks, region=None):
        seen["tracks"], seen["region"] = tracks, region
        return [{"match": None, "candidates": [], "error": None} for _ in tracks]

    monkeypatch.setattr(ytm, "match_many", fake)
    body = {"tracks": [{"id": "1", "title": "Song", "artists": ["A"], "duration_sec": 200, "isrc": "X"}], "region": "IN"}
    r = client.post("/api/ytm/match", json=body)
    assert r.status_code == 200 and len(r.json()["results"]) == 1
    assert seen["tracks"][0].isrc == "X" and seen["region"] == "IN"


def test_region_falls_back_when_unsupported():
    assert ytm.client("IN").context["context"]["client"]["gl"] == "IN"
    ytm.client("ZZ")  # unsupported: no error, default region


def test_lookup_rejects_garbage(client):
    r = client.post("/api/ytm/lookup", json={"url": "hello"})
    assert r.status_code == 400 and "link" in r.json()["detail"]
