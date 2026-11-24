# Dubdeck

Copy your Spotify playlists (and Liked Songs) to YouTube Music, with no Spotify login and no Premium.

**Live:** https://dubdeck-lime.vercel.app

1. **Add playlists**, any of these ways:
   - **Paste from the Spotify desktop app.** Open a playlist or Liked Songs, click a song, press
     Ctrl+A then Ctrl+C, and paste. Works for private playlists and any number of songs.
   - **Paste a link** to a public playlist or album. Spotify only shares the first 100 songs this way.
   - **Upload a file:**
     - an [Exportify](https://exportify.net) CSV (instant; includes ISRC codes for the best matches)
     - a TuneMyMusic CSV
     - Spotify's own data download (`Playlist1.json`, `YourLibrary.json`)
2. **Check matches.** Each song is looked up on YouTube Music by its ISRC when the file has one, then
   by title, artist and length. Each match gets a confidence meter. Uncertain ones (another remix, a
   live version, a big length difference) are flagged so you can pick another candidate or paste a link.
3. **Transfer.** Sign in with Google. Dubdeck creates private playlists through the official YouTube
   Data API.
   - Google's default limit is about 200 songs a day for each Google Cloud project.
   - When the limit runs out, the transfer pauses and saves its progress in your browser. Press
     **Continue transfer** after midnight Pacific time.

## How it's built

- **No credentials on the server.** The FastAPI backend is stateless and has two jobs:
  - reading song details from Spotify's public embed pages (no account needed)
  - searching YouTube Music anonymously via [ytmusicapi](https://github.com/sigma67/ytmusicapi)
- **Google sign-in runs in the browser** (Google Identity Services). The browser writes playlists to
  YouTube directly. The access token never reaches the server.
- **Everything you add lives in your browser's local storage:** playlists, matches and transfer progress.

```
app/
  main.py            FastAPI routes; serves public/ when run locally
  spotify_public.py  song details from Spotify's public embed pages
  ytm.py             YouTube Music search and matching
  matcher.py         title/artist/length scoring (no network)
public/              the web UI (plain HTML/CSS/JS, no build step)
tests/
```

Spotify's embed pages and ytmusicapi are unofficial interfaces, so either could change without notice.

## Google sign-in setup (once)

1. In the [Google Cloud console](https://console.cloud.google.com/projectcreate), create a project.
2. Enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and choose **Get started**:
   - pick **External**
   - under **Audience**, add your Gmail address as a test user
4. Under **Clients**, create a **Web application** client. Add these to **Authorized JavaScript origins**:
   - `https://dubdeck-lime.vercel.app` (or your own domain)
   - `http://127.0.0.1:8765` (for local use)
5. Provide the client ID in one of two ways:
   - set it as `GOOGLE_CLIENT_ID` in the Vercel project's environment variables, or
   - paste it into the page when Dubdeck asks.

While the app is in Testing mode, only the test users you add can sign in. Google shows an
"unverified app" notice; continue past it.

## Run locally

Needs [uv](https://docs.astral.sh/uv/).

```powershell
uv run python -m app
```

This opens http://127.0.0.1:8765. `PORT` and `NO_BROWSER=1` are optional.

## Deploy

The repo deploys to Vercel as-is. `app/main.py` is the FastAPI entrypoint and `public/` is served from
the CDN. Pushes to `main` deploy automatically.

## Tests

```powershell
uv run pytest
```
