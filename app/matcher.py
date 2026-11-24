"""Track matching: scores YouTube Music search results against a Spotify track.

Pure functions only (no network) so they are easy to unit test.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher

# Words that describe a release/packaging rather than a different recording.
_NOISE_WORDS = {
    "remaster", "remastered", "remasterd", "version", "single", "album", "mono", "stereo",
    "deluxe", "edition", "bonus", "track", "explicit", "clean", "original", "digital",
    "anniversary", "expanded", "special", "reissue", "the", "from", "soundtrack", "motion",
    "picture", "film", "movie", "ost", "official", "mix", "mixed", "edit", "radio",
    "video", "audio", "music", "lyrics", "lyric", "visualizer", "hd", "hq", "4k", "mv",
}
_NOISE_PATTERNS = re.compile(r"^\d{2,4}s?$|^\d+(st|nd|rd|th)$")

# Qualifiers that mean a *different recording* of the song.
_VERSION_FLAGS = {
    "live", "remix", "acoustic", "instrumental", "karaoke", "cover", "demo", "slowed",
    "sped", "reverb", "nightcore", "8d", "extended", "unplugged", "orchestral", "piano",
    "acapella", "a cappella", "rework", "bootleg", "mashup",
}

_FEAT_RE = re.compile(r"\b(feat|ft|featuring|with|prod)\b\.?", re.I)
_BRACKETS_RE = re.compile(r"[\(\[\{]([^\)\]\}]*)[\)\]\}]")
_DASH_SPLIT_RE = re.compile(r"\s+[-–—]\s+")


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm(s: str) -> str:
    """Lowercase, strip accents/punctuation, collapse whitespace."""
    s = strip_accents(s or "").lower()
    s = s.replace("&", " and ").replace("’", "'")
    s = re.sub(r"[^\w\s']", " ", s)
    s = s.replace("'", "")
    return re.sub(r"\s+", " ", s).strip()


def _qualifier_is_noise(q: str) -> bool:
    q_norm = norm(q)
    if not q_norm:
        return True
    if _FEAT_RE.match(q.strip()):
        return True
    if q_norm.startswith("from "):  # soundtrack credit: (From "Aashiqui 2")
        return True
    words = q_norm.split()
    return all(w in _NOISE_WORDS or _NOISE_PATTERNS.match(w) for w in words)


@dataclass
class ParsedTitle:
    base: str  # normalized core title ("mr brightside")
    full: str  # normalized full title with significant qualifiers kept
    flags: set[str] = field(default_factory=set)


def parse_title(title: str) -> ParsedTitle:
    """Split a title into its core and the qualifiers that matter.

    "Song - 2011 Remaster" -> base "song", no flags
    "Song (feat. X) [Live at Wembley]" -> base "song", flags {"live"}
    """
    title = title or ""
    qualifiers: list[str] = _BRACKETS_RE.findall(title)
    rest = _BRACKETS_RE.sub(" ", title)
    parts = _DASH_SPLIT_RE.split(rest)
    base_raw = parts[0]
    qualifiers.extend(parts[1:])

    # "Song feat. X" without brackets
    m = re.search(r"\s(feat\.?|ft\.?|featuring)\s", base_raw, re.I)
    if m:
        base_raw = base_raw[: m.start()]

    significant = [q for q in qualifiers if not _qualifier_is_noise(q)]
    flags: set[str] = set()
    for q in qualifiers:
        qn = norm(q)
        for flag in _VERSION_FLAGS:
            if re.search(rf"\b{re.escape(flag)}\b", qn):
                flags.add(flag)
    # Treat "slowed + reverb" / "sped up" as one family each
    if "reverb" in flags:
        flags.add("slowed")
    flags.discard("reverb")

    base = norm(base_raw)
    full = " ".join([base] + [norm(q) for q in significant]).strip()
    return ParsedTitle(base=base or norm(title), full=full or norm(title), flags=flags)


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    seq = SequenceMatcher(None, a, b).ratio()
    ta, tb = set(a.split()), set(b.split())
    jac = len(ta & tb) / len(ta | tb) if ta | tb else 0.0
    # one fully containing the other ("song" vs "song pt 1") gets partial credit
    contain = 0.85 if (f" {a} " in f" {b} " or f" {b} " in f" {a} ") else 0.0
    return max(seq, jac, contain)


def duration_score(a_sec: float | None, b_sec: float | None) -> float:
    if not a_sec or not b_sec:
        return 0.5
    d = abs(a_sec - b_sec)
    if d <= 3:
        return 1.0
    if d <= 7:
        return 0.85
    if d <= 15:
        return 0.55
    if d <= 30:
        return 0.25
    return 0.0


def artist_score(sp_artists: list[str], yt_artists: list[str]) -> float:
    sp = [norm(a) for a in sp_artists if a]
    yt = [norm(a) for a in yt_artists if a]
    if not sp or not yt:
        return 0.0
    yt_joined = " " + " ".join(yt) + " "
    primary = sp[0]
    if f" {primary} " in yt_joined:
        return 1.0
    best = max(similarity(primary, y) for y in yt)
    # credit for matching any secondary artist (YTM sometimes lists only the featured one)
    for other in sp[1:]:
        if f" {other} " in yt_joined:
            best = max(best, 0.85)
    return best


_VIDEO_NOISE_RE = re.compile(
    r"[\(\[]\s*(official|lyrics?|lyric video|audio|video|visuali[sz]er|hd|hq|4k|mv|m/v)[^\)\]]*[\)\]]",
    re.I,
)


def clean_video_title(title: str, yt_artists: list[str], sp_artists: list[str]) -> str:
    """Turn 'Artist - Song (Official Video)' into 'Song'."""
    t = _VIDEO_NOISE_RE.sub(" ", title or "")
    parts = _DASH_SPLIT_RE.split(t, maxsplit=1)
    if len(parts) == 2:
        left, right = parts
        names = [norm(a) for a in (yt_artists + sp_artists) if a]
        left_n, right_n = norm(left), norm(right)
        if any(n and (n in left_n or left_n in n) for n in names):
            return right
        if any(n and (n in right_n or right_n in n) for n in names):
            return left
    return t


@dataclass
class SpotifyTrack:
    id: str | None
    title: str
    artists: list[str]
    album: str = ""
    duration_sec: float | None = None
    isrc: str | None = None

    def query(self) -> str:
        artist = self.artists[0] if self.artists else ""
        return re.sub(r"\s+", " ", f"{query_title(self.title)} {artist}").strip()


def query_title(title: str) -> str:
    """Raw title minus noise ("- Remastered 2009", "(feat. X)"), keeping "(Live)", "(Taylor's Version)"."""
    t = _BRACKETS_RE.sub(lambda m: " " if _qualifier_is_noise(m.group(1)) else m.group(0), title or "")
    parts = _DASH_SPLIT_RE.split(t)
    t = " ".join([parts[0]] + [p for p in parts[1:] if not _qualifier_is_noise(p)])
    t = re.sub(r"\s(feat\.?|ft\.?|featuring)\s.*$", "", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip() or title


def score_candidate(track: SpotifyTrack, result: dict) -> float:
    """Return a 0..1 confidence that a ytmusicapi search result is this track."""
    yt_artists = [a.get("name", "") for a in (result.get("artists") or [])]
    is_video = result.get("resultType") == "video"
    yt_title = result.get("title") or ""
    if is_video:
        yt_title = clean_video_title(yt_title, yt_artists, track.artists)

    a = parse_title(track.title)
    b = parse_title(yt_title)

    base_sim = similarity(a.base, b.base)
    qualifiers_differ = False
    if a.full == a.base and b.full == b.base:
        t_score = base_sim
    else:
        # qualifiers like "Chromatics Remix" or "Live Aid" identify the recording: weigh them in
        full_sim = similarity(a.full, b.full)
        t_score = 0.5 * base_sim + 0.5 * full_sim
        qualifiers_differ = full_sim < 0.9
    ar_score = artist_score(track.artists, yt_artists)
    if is_video and ar_score < 0.8:
        # channel names are unreliable; artist may only appear in the raw video title
        raw = norm(result.get("title") or "")
        if track.artists and norm(track.artists[0]) and f" {norm(track.artists[0])} " in f" {raw} ":
            ar_score = max(ar_score, 0.9)
    d_score = duration_score(track.duration_sec, result.get("duration_seconds"))

    score = 0.5 * t_score + 0.3 * ar_score + 0.2 * d_score

    album = (result.get("album") or {}).get("name") if isinstance(result.get("album"), dict) else None
    if album and track.album and similarity(norm(album), norm(track.album)) > 0.85:
        score += 0.05

    if qualifiers_differ:
        score = min(score, 0.79)  # e.g. "(Taylor's Version)" vs the original, "Live Aid" vs "Live at Wembley"
    mismatched_flags = a.flags ^ b.flags
    if mismatched_flags:
        # different recording (live vs studio, remix vs original): never auto-accept
        score = min(score - min(0.4, 0.2 * len(mismatched_flags)), 0.79)
    yt_dur = result.get("duration_seconds")
    if track.duration_sec and yt_dur and abs(track.duration_sec - yt_dur) > 20:
        score = min(score, 0.79)  # very different length: probably another edit or version
    if is_video:
        score -= 0.05
    return round(max(0.0, min(1.0, score)), 3)


def confidence_label(score: float) -> str:
    if score >= 0.8:
        return "high"
    if score >= 0.62:
        return "medium"
    return "low"
