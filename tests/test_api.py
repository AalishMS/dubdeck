import pytest
from fastapi.testclient import TestClient

from app import main, spotify_public, ytm

REAL_API_GET = spotify_public._api_get  # the autouse fixture below replaces it


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
    monkeypatch.setitem(spotify_public._batch_blocked_until, "tracks", 0.0)
    monkeypatch.setitem(spotify_public._batch_blocked_until, "metadata", 0.0)
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


def metadata_track(id_, name, isrc):
    """The shape spclient's metadata endpoint answers with."""
    return {
        "name": name,
        "artist": [{"name": "Artist"}],
        "album": {"name": "Album"},
        "duration": 180000,
        "external_id": [{"type": "isrc", "id": isrc}],
    }


def fake_spotify(playlist_ids, missing=(), fail_tracks=False, metadata=False, calls=None):
    """Stands in for _api_get: one playlist, song details by id, and one profile.

    fail_tracks: True makes /v1/tracks unavailable, "quota" makes it say 429 for a day.
    metadata: whether the one-song metadata endpoint answers.
    """
    calls = calls if calls is not None else []
    known = {spotify_public._gid(i): i for i in playlist_ids if ":" not in i}

    def get(url, params=None):
        params = params or {}
        calls.append(url)
        if "/playlist/v2/playlist/" in url:
            start = params.get("from", 0)
            page = playlist_ids[start : start + 150]  # smaller than the playlist, to exercise paging
            items = [{"uri": u if ":" in u else f"spotify:track:{u}"} for u in page]
            return {"length": len(playlist_ids), "attributes": {"description": "Rock &amp; <a href='x'>roll</a>"}, "contents": {"items": items}}
        if url.endswith("/tracks"):
            if fail_tracks == "quota":
                raise spotify_public._RateLimited(83000)
            if fail_tracks:
                raise spotify_public._Unavailable("rate limited")
            return {"tracks": [None if i in missing else api_track(i, f"Song {i[-3:]}", f"us{i[-3:]}") for i in params["ids"].split(",")]}
        if "/metadata/4/track/" in url:
            if metadata == "quota":
                raise spotify_public._RateLimited(3600)
            if not metadata:
                raise spotify_public._Unavailable("offline in tests")
            i = known.get(url.rsplit("/", 1)[-1])
            return None if i is None or i in missing else metadata_track(i, f"Song {i[-3:]}", f"us{i[-3:]}")
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


def test_gid_matches_spotifys_hex_ids():
    assert spotify_public._gid("003vvx7Niy0yvhvHt4a68B") == "0007ad33dd9041698f5749da79d310bd"


def test_whole_playlist_still_comes_over_when_batch_quota_is_used_up(client, monkeypatch):
    ids = song_ids(240)
    calls = []
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: PLAYLIST_ENTITY)
    monkeypatch.setattr(spotify_public, "_api_get", fake_spotify(ids, fail_tracks="quota", metadata=True, calls=calls))
    body = client.post("/api/spotify/collection", json={"kind": "playlist", "id": "37i9dQZF1DX4UtSsGT1Sbe"}).json()
    assert [t["id"] for t in body["tracks"]] == ids
    assert body["tracks"][0] == {"id": ids[0], "title": "Song 000", "artists": ["Artist"], "album": "Album", "duration_sec": 180.0, "isrc": "US000"}
    assert body["maybe_truncated"] is False

    # Spotify said to come back tomorrow (clamped to a few hours), so the next request skips the batch endpoint.
    import time
    assert time.time() < spotify_public._batch_blocked_until["tracks"] <= time.time() + spotify_public._MAX_BLOCK
    batch_calls = sum(u.endswith("/tracks") for u in calls)
    spotify_public._track_cache.clear()
    client.post("/api/spotify/tracks", json={"ids": ids[:2]})
    assert sum(u.endswith("/tracks") for u in calls) == batch_calls


def test_metadata_miss_falls_back_to_the_embed_page(client, monkeypatch):
    ids = song_ids(2)
    monkeypatch.setattr(spotify_public, "_api_get", fake_spotify(ids, missing={ids[1]}, fail_tracks="quota", metadata=True))
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: TRACK_ENTITY if i == ids[1] else pytest.fail("only the miss goes to its embed page"))
    first, second = client.post("/api/spotify/tracks", json={"ids": ids}).json()["tracks"]
    assert first["isrc"] == "US000"
    assert second["title"] == "Mr. Brightside" and second["isrc"] is None


def test_metadata_rate_limit_stops_asking(client, monkeypatch):
    ids = song_ids(120)
    calls = []
    monkeypatch.setattr(spotify_public, "_entity", lambda kind, i: PLAYLIST_ENTITY)
    monkeypatch.setattr(spotify_public, "_api_get", fake_spotify(ids, fail_tracks="quota", metadata="quota", calls=calls))
    body = client.post("/api/spotify/collection", json={"kind": "playlist", "id": "37i9dQZF1DX4UtSsGT1Sbe"}).json()
    assert [t["title"] for t in body["tracks"]] == []  # none of these ids are on the embed page
    assert body["maybe_truncated"] is True
    assert sum("/metadata/4/track/" in u for u in calls) < len(ids)  # it stopped once Spotify said 429


class FakeResponse:
    def __init__(self, status, headers=None, body=None):
        self.status_code, self.headers, self._body = status, headers or {}, body

    def json(self):
        return self._body


@pytest.mark.parametrize(("header", "expected"), [("83357", 83357.0), (None, 60.0)])
def test_api_get_reports_long_rate_limits(monkeypatch, header, expected):
    monkeypatch.setattr(spotify_public, "_anon_token", lambda refresh=False: "token")
    resp = FakeResponse(429, {"Retry-After": header} if header else {})
    monkeypatch.setattr(spotify_public, "_session", lambda: type("S", (), {"get": lambda self, *a, **k: resp})())
    with pytest.raises(spotify_public._RateLimited) as e:
        REAL_API_GET("https://api.spotify.com/v1/tracks")
    assert e.value.retry_after == expected


def test_api_get_waits_out_a_short_rate_limit(monkeypatch):
    answers = [FakeResponse(429, {"Retry-After": "0"}), FakeResponse(200, body={"ok": True})]
    monkeypatch.setattr(spotify_public, "_anon_token", lambda refresh=False: "token")
    monkeypatch.setattr(spotify_public, "_session", lambda: type("S", (), {"get": lambda self, *a, **k: answers.pop(0)})())
    assert REAL_API_GET("https://api.spotify.com/v1/tracks") == {"ok": True}


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


class FakeYTM:
    def search(self, query, filter=None, limit=10):
        songs = [
            {"videoId": "aaaaaaaaaaa", "title": "Mr. Brightside", "artists": [{"name": "The Killers"}], "duration_seconds": 223, "resultType": "song"},
            {"videoId": "bbbbbbbbbbb", "title": "Mr. Brightside (Live)", "artists": [{"name": "The Killers"}], "duration_seconds": 250, "resultType": "song"},
            {"title": "An artist page, no videoId"},
        ]
        videos = [
            {"videoId": "ccccccccccc", "title": "The Killers - Mr. Brightside (Official Video)", "artists": [{"name": "The Killers"}], "duration_seconds": 228, "resultType": "video"},
            {"videoId": "aaaaaaaaaaa", "title": "Mr. Brightside", "artists": [{"name": "The Killers"}], "duration_seconds": 223, "resultType": "video"},
        ]
        return songs if filter == "songs" else videos


def test_search_keeps_youtubes_order_and_scores_each_result(client, monkeypatch):
    monkeypatch.setattr(ytm, "client", lambda region=None: FakeYTM())
    track = {"id": "003vvx7Niy0yvhvHt4a68B", "title": "Mr. Brightside", "artists": ["The Killers"], "duration_sec": 222.9}
    r = client.post("/api/ytm/search", json={"query": "  brightside   killers ", "track": track, "region": "GB"})
    cands = r.json()["candidates"]
    assert r.status_code == 200
    assert [c["videoId"] for c in cands] == ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]  # songs first, no duplicates
    assert cands[0]["confidence"] == "high" and cands[1]["confidence"] != "high"
    assert cands[2]["type"] == "video" and cands[0]["method"] == "search"


def test_search_validates_input(client):
    track = {"title": "Song", "artists": ["A"]}
    assert client.post("/api/ytm/search", json={"query": "", "track": track}).status_code == 422
    assert client.post("/api/ytm/search", json={"query": "x" * 201, "track": track}).status_code == 422
    assert client.post("/api/ytm/search", json={"query": "song"}).status_code == 422
    r = client.post("/api/ytm/search", json={"query": "   ", "track": track})
    assert r.status_code == 400 and "search" in r.json()["detail"]


def test_lookup_rejects_garbage(client):
    r = client.post("/api/ytm/lookup", json={"url": "hello"})
    assert r.status_code == 400 and "link" in r.json()["detail"]
