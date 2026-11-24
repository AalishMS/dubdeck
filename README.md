# Dubdeck

A small web app that copies your Spotify playlists (and Liked Songs) to YouTube Music.

1. **Connect** Spotify and YouTube Music.
2. **Choose** playlists.
3. **Check matches.** Every song is looked up on YouTube Music: first by its ISRC (the recording's
   industry ID), then by title, artist and length. Each match gets a confidence meter. Uncertain
   ones (a different remix, a live version, a big length difference) are flagged so you can pick
   another candidate or paste a link.
4. **Transfer.** Dubdeck creates the playlists (private by default) and adds the songs. Liked Songs can
   become a playlist, or each song can be liked on YouTube Music.

## How it's built

- **Spotify runs entirely in your browser.** It uses Authorization Code with PKCE, so there's no
  client secret, and the token never reaches the server.
- **YouTube Music has no public API.** The small FastAPI backend uses
  [ytmusicapi](https://github.com/sigma67/ytmusicapi) with a copy of your browser's request headers.
  The headers live in your browser and are sent with each request. The server is **stateless** and
  never stores them.
- **The page drives the work.** It matches songs a few at a time and adds them in batches of 50, so
  every server call is short. That means it runs the same way on your computer and on Vercel. Keep
  the tab open while it works.

```
app/
  main.py      FastAPI: /api/ytm/* endpoints (stateless); serves public/ when run locally
  ytm.py       YouTube Music: header parsing, search and matching, playlist writes
  matcher.py   title/artist/length scoring (no network)
public/        the web UI (plain HTML/CSS/JS, no build step), incl. Spotify PKCE login
tests/         matcher and API tests
```

## Run it locally

Needs [uv](https://docs.astral.sh/uv/).

```powershell
uv run python -m app
```

This opens http://127.0.0.1:8765. Use `127.0.0.1`, not `localhost`: Spotify only accepts that
form for local redirect URIs. `PORT` and `NO_BROWSER=1` are optional.

## Deploy to Vercel

The repo deploys to Vercel as-is. `app/main.py` is picked up as the FastAPI entrypoint and
`public/` is served from the CDN.

- **Optional:** set `SPOTIFY_CLIENT_ID` in the project's environment variables. Then nobody needs to
  type it into the page.
- **Required:** add `https://<your-domain>/callback.html` as a Redirect URI in your Spotify app.

## One-time setup

### Spotify

Spotify requires every tool like this to have its own developer app:

1. Go to https://developer.spotify.com/dashboard and choose **Create app**.
2. Add the redirect URIs you'll use:
   - `http://127.0.0.1:8765/callback.html` (local)
   - `https://<your-domain>/callback.html` (hosted)
3. Tick **Web API**, save, and copy the **Client ID** into Dubdeck.

Spotify's rules for these developer apps (changed in February 2026):

- The app owner needs **Spotify Premium**.
- Up to 5 users. To use it with another Spotify account, add that account under **User Management**.
- Only playlists you **own or collaborate on** can be read. For a playlist you only follow (including
  Spotify-made ones such as Discover Weekly), open it in Spotify, select all songs (Ctrl+A) and add
  them to a new playlist of your own.

### YouTube Music

1. Open https://music.youtube.com while signed in.
2. Press F12, open **Network**, and filter for `browse`.
3. Click **Library** so a `browse` request appears.
4. Right-click it, then **Copy → Copy request headers** (Chrome/Edge). In Firefox: Headers → Raw → copy.
5. Paste into Dubdeck.

These headers act like a password for your Google account. They're kept in your browser's local
storage. Use **Disconnect** when you're done. They stop working when you sign out of YouTube Music
in the browser you copied them from.

## Tests

```powershell
uv run pytest
```

## Troubleshooting

- **"Spotify only lets apps read playlists you own or collaborate on"**: see the Spotify rules above.
- **Spotify says the redirect URI is invalid**: the URI in your Spotify app must exactly match the one
  shown on Dubdeck's connect screen, including `/callback.html`.
- **YouTube Music headers stop working**: they expire when you sign out of that browser. Disconnect
  and paste fresh ones from a new `browse` request.
- **Brand account / channel**: the headers decide which account is used. Switch to that account in
  YouTube Music before copying them.
