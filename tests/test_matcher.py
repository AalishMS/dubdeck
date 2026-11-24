from app.matcher import SpotifyTrack, parse_title, score_candidate, confidence_label


def r(title, artists, dur=None, album=None, kind="song"):
    return {
        "videoId": "x" * 11,
        "title": title,
        "artists": [{"name": a} for a in artists],
        "duration_seconds": dur,
        "album": {"name": album} if album else None,
        "resultType": kind,
    }


def test_parse_title_drops_noise_keeps_versions():
    assert parse_title("Mr. Brightside").base == "mr brightside"
    p = parse_title("Here Comes The Sun - Remastered 2009")
    assert p.base == "here comes the sun" and not p.flags and p.full == "here comes the sun"
    p = parse_title("Song (feat. Someone) [Live at Wembley]")
    assert p.base == "song" and p.flags == {"live"}
    assert parse_title("Track - Radio Edit").flags == set()
    assert parse_title("Love Story (Taylor's Version)").full == "love story taylors version"
    assert parse_title("Blinding Lights - Chromatics Remix").flags == {"remix"}
    assert parse_title("Song (Slowed + Reverb)").flags == {"slowed"}


def test_exact_song_scores_high():
    t = SpotifyTrack("1", "Mr. Brightside", ["The Killers"], "Hot Fuss", 222.0)
    s = score_candidate(t, r("Mr. Brightside", ["The Killers"], 223, "Hot Fuss"))
    assert s >= 0.95 and confidence_label(s) == "high"


def test_remaster_suffix_still_matches():
    t = SpotifyTrack("1", "Here Comes The Sun - Remastered 2009", ["The Beatles"], "Abbey Road", 185.7)
    assert score_candidate(t, r("Here Comes The Sun (Remastered 2009)", ["The Beatles"], 186)) >= 0.9
    assert score_candidate(t, r("Here Comes The Sun", ["The Beatles"], 186)) >= 0.9


def test_cover_by_other_artist_scores_lower():
    t = SpotifyTrack("1", "Mr. Brightside", ["The Killers"], "Hot Fuss", 222.0)
    right = score_candidate(t, r("Mr. Brightside", ["The Killers"], 223))
    cover = score_candidate(t, r("Mr. Brightside", ["McFly"], 211))
    assert right - cover > 0.25 and confidence_label(cover) != "high"


def test_live_version_penalized():
    t = SpotifyTrack("1", "Mr. Brightside", ["The Killers"], "", 222.0)
    live = score_candidate(t, r("Mr. Brightside (Live)", ["The Killers"], 240))
    assert confidence_label(live) != "high"
    # and the other way round, even when the duration happens to line up
    t2 = SpotifyTrack("2", "Bohemian Rhapsody - Live Aid", ["Queen"], "", 357.0)
    studio = score_candidate(t2, r("Bohemian Rhapsody", ["Queen"], 355))
    assert confidence_label(studio) != "high"


def test_named_remix_prefers_the_right_remix():
    t = SpotifyTrack("1", "Blinding Lights - Chromatics Remix", ["The Weeknd", "Chromatics"], "", 262.0)
    right = score_candidate(t, r("Blinding Lights (Chromatics Remix) (feat. Chromatics)", ["The Weeknd"], 262))
    other = score_candidate(t, r("Blinding Lights (Remix)", ["The Weeknd", "ROSALÍA"], 217))
    assert right > other
    assert confidence_label(right) == "high"
    assert confidence_label(other) != "high"


def test_other_live_recording_needs_review():
    t = SpotifyTrack("1", "Bohemian Rhapsody - Live Aid", ["Queen"], "", 357.0)
    s = score_candidate(t, r("Bohemian Rhapsody (Live)", ["Queen"], 329, "Queen Rock Montreal"))
    assert confidence_label(s) == "medium"


def test_big_length_difference_never_auto_accepted():
    t = SpotifyTrack("1", "Song", ["Artist"], "", 200.0)
    assert confidence_label(score_candidate(t, r("Song", ["Artist"], 260))) == "medium"


def test_different_live_venue_needs_review():
    t = SpotifyTrack("1", "Bohemian Rhapsody - Live Aid", ["Queen"], "", 357.0)
    s = score_candidate(t, r("Bohemian Rhapsody (Live At Wembley Stadium)", ["Queen"], 351))
    assert confidence_label(s) == "medium"


def test_taylors_version_vs_original_needs_review():
    t = SpotifyTrack("1", "Love Story (Taylor’s Version)", ["Taylor Swift"], "", 235.8)
    assert confidence_label(score_candidate(t, r("Love Story", ["Taylor Swift"], 235))) == "medium"
    assert confidence_label(score_candidate(t, r("Love Story (Taylor's Version)", ["Taylor Swift"], 236))) == "high"


def test_query_keeps_meaningful_qualifiers_only():
    assert SpotifyTrack("1", "Here Comes The Sun - Remastered 2009", ["The Beatles"]).query() == "Here Comes The Sun The Beatles"
    assert SpotifyTrack("1", "Stay (with Justin Bieber)", ["The Kid LAROI"]).query() == "Stay The Kid LAROI"
    assert SpotifyTrack("1", "Love Story (Taylor’s Version)", ["Taylor Swift"]).query() == "Love Story (Taylor’s Version) Taylor Swift"
    assert SpotifyTrack("1", "Bohemian Rhapsody - Live Aid", ["Queen"]).query() == "Bohemian Rhapsody Live Aid Queen"
    assert SpotifyTrack("1", 'Let It Go - From "Frozen"', ["Idina Menzel"]).query() == "Let It Go Idina Menzel"


def test_movie_qualifier_still_high():
    t = SpotifyTrack("1", "Tum Hi Ho", ["Mithoon", "Arijit Singh"], "Aashiqui 2", 262.0)
    assert confidence_label(score_candidate(t, r('Tum Hi Ho (From "Aashiqui 2")', ["Arijit Singh"], 262))) == "high"


def test_featured_artist_formats():
    t = SpotifyTrack("1", "Stay (with Justin Bieber)", ["The Kid LAROI", "Justin Bieber"], "", 141.8)
    assert score_candidate(t, r("Stay", ["The Kid LAROI", "Justin Bieber"], 142)) >= 0.9
    assert score_candidate(t, r("STAY", ["The Kid LAROI & Justin Bieber"], 142)) >= 0.9


def test_official_video_title_parsing():
    t = SpotifyTrack("1", "Mr. Brightside", ["The Killers"], "", 222.0)
    s = score_candidate(t, r("The Killers - Mr. Brightside (Official Music Video)", ["TheKillersVEVO"], 228, kind="video"))
    assert s >= 0.75


def test_unrelated_song_scores_low():
    t = SpotifyTrack("1", "Mr. Brightside", ["The Killers"], "", 222.0)
    assert confidence_label(score_candidate(t, r("Shape of You", ["Ed Sheeran"], 233))) == "low"


def test_accents_and_case():
    t = SpotifyTrack("1", "Despacito", ["Luis Fonsi", "Daddy Yankee"], "", 229.0)
    assert score_candidate(t, r("DESPACITO", ["Luís Fonsi"], 229)) >= 0.9
