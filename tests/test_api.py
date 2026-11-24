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
    privacy = client.get("/privacy.html")  # Google's OAuth consent screen links to this page
    assert privacy.status_code == 200 and "YouTube API Services" in privacy.text
    assert 'href="/privacy.html"' in r.text


def test_rejects_other_hosts():
    assert TestClient(main.app, base_url="http://evil.example").get("/api/config").status_code == 400


def test_config_reads_env(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com")
    assert client.get("/api/config").json() == {"google_client_id": "123-abc.apps.googleusercontent.com"}
    monkeypatch.delenv("GOOGLE_CLIENT_ID")
    assert client.get("/api/config").json() == {"google_client_id": None}


# ---------------------------------------------------------------- spotify (public embeds)


@pytest.fixture(autouse=True)
def no_spotify_network(monkeypatch):
    """By default the anonymous-token route is down, so each test sees the embed-only behaviour."""

    def down(url, params=None):
        raise spotify_public._Unavailable("offline in tests")

    spotify_public._track_cache.clear()
    monkeypatch.setattr(spotify_public, "_api_get", down)


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


# ---------------------------------------------------------------- spotify (the embed's anonymous token)


def api_track(id_, name, isrc):
    return {
        "id": id_,
        "name": name,
        "artists": [{"name": "Artist"}],
        "album": {"name": "Album"},
        "duration_ms": 180000,
        "external_ids": {"isrc": isrc},
    }


def fake_spotify(playlist_ids, missing=(), fail_tracks=False):
    """Stands in for _api_get: one playlist, song details by id, and one profile."""

    def get(url, params=None):
        params = params or {}
        if "/playlist/v2/playlist/" in url:
            start = params.get("from", 0)
            page = playlist_ids[start : start + 150]  # smaller than the playlist, to exercise paging
            items = [{"uri": u if ":" in u else f"spotify:track:{u}"} for u in page]
            return {"length": len(playlist_ids), "attributes": {"description": "Rock &amp; <a href='x'>roll</a>"}, "contents": {"items": items}}
        if url.endswith("/tracks"):
            if fail_tracks:
                raise spotify_public._Unavailable("rate limited")
            return {"tracks": [None if i in missing else api_track(i, f"Song {i[-3:]}", f"us{i[-3:]}") for i in params["ids"].split(",")]}
        if url.endswith("/users/aalish"):
            return {"display_name": "Aalish"}
        if url.endswith("/users/aalish/playlists"):
            rows = [
                {"id": "37i9dQZF1DX4UtSsGT1Sbe", "name": "Road trip", "owner": {"display_name": "Aalish"}, "images": [{"url": "https://i.scdn.co/image/x"}], "description": "Windows &amp; down", "items": {"total": 240}},
                None,
                {"id": "37i9dQZF1DWXRqgorJj26U", "name": "Old shape", "owner": {}, "images": None, "tracks": {"total": 3}},
            ]
            return {"items": rows, "next": None}
        return None  # Spotify's 404

    return get


def song_ids(n):
    return [f"{i:022d}" for i in range(n)]


def test_playlist_link_reads_every_song_with_isrc(client, monkeypatch):
    ids = song_ids(240)
    in_playlist = ids[:5] + ["spotify:episode:5Xt5DXGzch68nYYamXrNxZ", "spotify:local:a:b:c:200"] + ids[5:]
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: PLAYLIST_ENTITY)
    monkeypatch.setattr(spotify_public, "_api_get", fake_spotify(in_playlist, missing={ids[7]}))
    body = client.post("/api/spotify/collection", json={"kind": "playlist", "id": "37i9dQZF1DX4UtSsGT1Sbe"}).json()
    assert [t["id"] for t in body["tracks"]] == [i for i in ids if i != ids[7]]  # in order, past the embed's 100
    assert body["tracks"][0] == {"id": ids[0], "title": "Song 000", "artists": ["Artist"], "album": "Album", "duration_sec": 180.0, "isrc": "US000"}
    assert body["description"] == "Rock & roll"
    assert body["maybe_truncated"] is False


def test_playlist_link_says_when_songs_could_not_be_read(client, monkeypatch):
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: PLAYLIST_ENTITY)
    monkeypatch.setattr(spotify_public, "_api_get", fake_spotify(["003vvx7Niy0yvhvHt4a68B"] + song_ids(3), fail_tracks=True))
    body = client.post("/api/spotify/collection", json={"kind": "playlist", "id": "37i9dQZF1DX4UtSsGT1Sbe"}).json()
    assert [t["title"] for t in body["tracks"]] == ["Mr. Brightside"]  # only the song the embed page described
    assert body["maybe_truncated"] is True


def test_tracks_come_in_batches_and_fall_back_to_embeds(client, monkeypatch):
    ids = song_ids(2)
    monkeypatch.setattr(spotify_public, "_api_get", fake_spotify([], missing={ids[1]}))
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: pytest.fail("an answered song must not be re-read from its embed page"))
    first, second = client.post("/api/spotify/tracks", json={"ids": ids}).json()["tracks"]
    assert first["isrc"] == "US000" and second is None


def test_profile_link_lists_public_playlists(client, monkeypatch):
    monkeypatch.setattr(spotify_public, "_api_get", fake_spotify([]))
    body = client.post("/api/spotify/user", json={"id": "aalish"}).json()
    assert body["name"] == "Aalish"
    assert body["playlists"] == [
        {"id": "37i9dQZF1DX4UtSsGT1Sbe", "name": "Road trip", "owner": "Aalish", "image": "https://i.scdn.co/image/x", "description": "Windows & down", "count": 240},
        {"id": "37i9dQZF1DWXRqgorJj26U", "name": "Old shape", "owner": "", "image": None, "description": "", "count": 3},
    ]


def test_profile_errors_are_explained(client, monkeypatch):
    assert client.post("/api/spotify/user", json={"id": "a/b"}).status_code == 422
    r = client.post("/api/spotify/user", json={"id": "aalish"})  # token route down
    assert r.status_code == 503 and "Paste the links" in r.json()["detail"]
    monkeypatch.setattr(spotify_public, "_api_get", fake_spotify([]))
    r = client.post("/api/spotify/user", json={"id": "nobody"})
    assert r.status_code == 404 and "no profile" in r.json()["detail"]


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
