// Dubdeck front end. Plain JS, no build step.
//
// 1. Add playlists: paste Spotify song/playlist links (read via /api/spotify/*, no login)
//    or upload an Exportify / TuneMyMusic CSV or Spotify data-download JSON.
// 2. Check matches: /api/ytm/match searches YouTube Music anonymously.
// 3. Transfer: the browser signs in with Google and writes playlists through the official
//    YouTube Data API. Progress is saved so a transfer can continue after Google's daily limit.
// Everything the user adds lives in this browser's localStorage.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem("dubdeck:" + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem("dubdeck:" + k, JSON.stringify(v)); return true; } catch { return false; }
  },
  del(k) { try { localStorage.removeItem("dubdeck:" + k); } catch {} },
};

class HttpError extends Error {
  constructor(message, status, reason = "") { super(message); this.status = status; this.reason = reason; }
}

async function api(path, { method = "GET", body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new HttpError("Can't reach the Dubdeck server. Check your connection and try again.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg).join("; ") : `Request failed (${res.status})`;
    throw new HttpError(msg, res.status);
  }
  return data;
}

const fmtTime = (s) => {
  if (!s && s !== 0) return "";
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const plural = (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const region = (() => {
  for (const l of navigator.languages || [navigator.language || ""]) {
    const m = /^[a-z]{2,3}-([A-Z]{2})$/i.exec(l);
    if (m) return m[1].toUpperCase();
  }
  return null;
})();

// ------------------------------------------------------------------ state

const state = {
  config: { google_client_id: null },
  library: store.get("library", []), // [{ uid, name, image, owner, liked, source, note, description, tracks }]
  selected: new Set(store.get("selected", [])),
  review: store.get("review"),
  transfer: store.get("transfer"),
  filter: "all",
  openAlt: null,
  shown: {},
  run: null, // { kind, cancelled } while importing / matching / transferring
  view: null,
};
const matchCache = new Map();

function saveLibrary() {
  const ok = store.set("library", state.library);
  store.set("selected", [...state.selected]);
  if (!ok) flash("Your playlists are too big to save in this browser. They'll work now, but will be gone if you reload.");
}

// ------------------------------------------------------------------ importing: paste

const LINK_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|playlist|album)\/|spotify:(track|playlist|album):)([A-Za-z0-9]{22})/g;

function parsePaste(text) {
  const trackIds = [];
  const collections = [];
  for (const m of text.matchAll(LINK_RE)) {
    const kind = m[1] || m[2];
    if (kind === "track") trackIds.push(m[3]);
    else if (!collections.some((c) => c.id === m[3])) collections.push({ kind, id: m[3] });
  }
  const localFiles = (text.match(/spotify:local:|open\.spotify\.com\/local\//g) || []).length;
  return { trackIds, collections, localFiles };
}

function libEntry(fields) {
  return { uid: uid(), name: "Untitled", image: null, owner: "", liked: false, source: "paste", note: null, description: "", tracks: [], ...fields };
}

function addToLibrary(entries) {
  const nonEmpty = entries.filter((e) => e.tracks.length);
  state.library.push(...nonEmpty);
  nonEmpty.forEach((e) => state.selected.add(e.uid));
  saveLibrary();
  return nonEmpty.length;
}

$("#form-paste").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFlash();
  const { trackIds, collections, localFiles } = parsePaste($("#paste-box").value);
  if (!trackIds.length && !collections.length) {
    flash("No Spotify links found. In the Spotify desktop app, select songs with Ctrl+A, copy them with Ctrl+C, and paste them here.");
    return;
  }
  const name = $("#paste-name").value.trim();
  beginRun("import");
  setWork("Reading songs from Spotify", "Song details come from Spotify's public pages, so no login is needed.");
  setLabels("Spotify", "Reading…");
  show("working");

  const added = [];
  const problems = [];
  for (const [i, c] of collections.entries()) {
    if (state.run.cancelled) break;
    tick({ label: `Reading ${c.kind} ${i + 1} of ${collections.length}…`, done: 0, total: 0, verb: "Reading…" });
    try {
      const col = await api("/api/spotify/collection", { method: "POST", body: c });
      added.push(libEntry({
        name: col.name, image: col.image, owner: col.owner, source: c.kind, tracks: col.tracks,
        note: col.maybe_truncated ? "Only the first 100 songs. Paste the rest from the app." : null,
      }));
    } catch (err) {
      problems.push(err.message);
    }
  }

  if (trackIds.length && !state.run.cancelled) {
    const unique = [...new Set(trackIds)];
    const found = new Map();
    const queue = [];
    for (let i = 0; i < unique.length; i += 40) queue.push(unique.slice(i, i + 40));
    let done = 0;
    const worker = async () => {
      while (queue.length && !state.run.cancelled) {
        const ids = queue.shift();
        try {
          const { tracks } = await api("/api/spotify/tracks", { method: "POST", body: { ids } });
          ids.forEach((id, k) => tracks[k] && found.set(id, tracks[k]));
        } catch (err) {
          problems.push(err.message);
        }
        done += ids.length;
        tick({ label: "Reading song details from Spotify…", done, total: unique.length });
      }
    };
    await Promise.all([worker(), worker()]);
    const tracks = trackIds.map((id) => found.get(id)).filter(Boolean);
    const missing = trackIds.length - tracks.length;
    added.push(libEntry({
      name: name || `Pasted songs ${new Date().toLocaleDateString()}`,
      source: "paste",
      tracks,
      note: missing ? `${plural(missing, "song")} couldn't be read` : null,
    }));
  }

  const cancelled = state.run.cancelled;
  state.run = null;
  setTape(0, false);
  resetDeck();
  const n = addToLibrary(added);
  if (n) {
    $("#paste-box").value = "";
    $("#paste-name").value = "";
  }
  const notes = [...new Set(problems)];
  if (localFiles) notes.push(`${plural(localFiles, "local file")} skipped: local files aren't on Spotify, so they can't be matched.`);
  if (cancelled) notes.unshift("Stopped. Anything read before you stopped was added.");
  goAdd();
  if (notes.length) flash(notes.join(" "));
});

// ------------------------------------------------------------------ importing: files

function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

const idFrom = (s) => (/(?:track[/:])([A-Za-z0-9]{22})/.exec(s || "") || [])[1] || null;
const baseName = (fileName) => fileName.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
const isLikedName = (n) => /^liked[ _-]?songs$/i.test(n.trim());

function parseDuration(v, header) {
  v = (v || "").trim();
  if (!v) return null;
  if (/^\d+:\d{2}(:\d{2})?$/.test(v)) return v.split(":").reduce((a, x) => a * 60 + Number(x), 0);
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /\(ms\)|ms\b/i.test(header) || n > 10000 ? n / 1000 : n;
}

function fromCSV(text, fileName) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error(`${fileName}: no songs found.`);
  const header = rows[0].map((x) => x.trim());
  const col = (...patterns) => {
    for (const re of patterns) {
      const i = header.findIndex((x) => re.test(x));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iTitle = col(/^track name$/i, /^(song|song name|title|track|track title|name)$/i, /track.?name/i, /title/i);
  const iArtist = col(/^artist name\(s\)$/i, /^artist name$/i, /^artists?$/i, /^(?!album).*artist/i);
  const iAlbum = col(/^album name$/i, /^album$/i, /^album.?(name|title)$/i);
  const iDur = col(/duration/i, /^length$/i, /^time$/i);
  const iIsrc = col(/isrc/i);
  const iUri = col(/^track uri$/i, /^spotify.*(id|uri|url)$/i, /^(uri|url)$/i);
  const iPl = col(/^playlist( name)?$/i, /^playlist/i);
  if (iTitle < 0 || iArtist < 0) throw new Error(`${fileName}: couldn't find the song title and artist columns.`);

  const groups = new Map();
  for (const r of rows.slice(1)) {
    const title = (r[iTitle] || "").trim();
    if (!title) continue;
    const artists = (r[iArtist] || "").split(/(?<!\\),|;/).map((a) => a.replace(/\\,/g, ",").trim()).filter(Boolean);
    const group = iPl >= 0 && r[iPl]?.trim() ? r[iPl].trim() : baseName(fileName);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({
      id: iUri >= 0 ? idFrom(r[iUri]) : null,
      title,
      artists,
      album: iAlbum >= 0 ? (r[iAlbum] || "").trim() : "",
      duration_sec: iDur >= 0 ? parseDuration(r[iDur], header[iDur]) : null,
      isrc: iIsrc >= 0 ? (r[iIsrc] || "").trim().toUpperCase() || null : null,
    });
  }
  return [...groups].map(([name, tracks]) =>
    libEntry({ name: isLikedName(name) ? "Liked Songs" : name, liked: isLikedName(name), source: "file", tracks })
  );
}

function fromSpotifyExport(obj, fileName) {
  if (Array.isArray(obj?.playlists)) {
    return obj.playlists.map((p) => libEntry({
      name: p.name || "Untitled",
      description: p.description || "",
      source: "export",
      tracks: (p.items || []).map((it) => it.track).filter((t) => t?.trackName).map((t) => ({
        id: idFrom(t.trackUri), title: t.trackName, artists: [t.artistName].filter(Boolean), album: t.albumName || "", duration_sec: null, isrc: null,
      })),
    }));
  }
  if (Array.isArray(obj?.tracks)) {
    return [libEntry({
      name: "Liked Songs", liked: true, source: "export",
      tracks: obj.tracks.filter((t) => t?.track).map((t) => ({
        id: idFrom(t.uri), title: t.track, artists: [t.artist].filter(Boolean), album: t.album || "", duration_sec: null, isrc: null,
      })),
    })];
  }
  throw new Error(`${fileName}: this isn't a Spotify playlist (Playlist1.json) or library (YourLibrary.json) file.`);
}

async function importFiles(files) {
  clearFlash();
  const added = [];
  const problems = [];
  for (const f of files) {
    try {
      if (/\.zip$/i.test(f.name)) throw new Error(`${f.name}: unzip it first, then upload the files inside.`);
      if (f.size > 40 * 1024 * 1024) throw new Error(`${f.name}: file is too big.`);
      const text = await f.text();
      if (/\.json$/i.test(f.name) || /^\s*[{[]/.test(text)) added.push(...fromSpotifyExport(JSON.parse(text), f.name));
      else added.push(...fromCSV(text, f.name));
    } catch (err) {
      problems.push(err instanceof SyntaxError ? `${f.name}: not valid JSON.` : err.message);
    }
  }
  const n = addToLibrary(added);
  renderShelf();
  renderDecks();
  if (problems.length) flash(problems.join(" "));
  else if (!n) flash("Those files didn't contain any songs.");
}

$("#file-input").addEventListener("change", (e) => {
  importFiles([...e.target.files]);
  e.target.value = "";
});
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => dz.addEventListener(t, () => dz.classList.remove("over")));
dz.addEventListener("drop", (e) => { e.preventDefault(); importFiles([...e.dataTransfer.files]); });

// ------------------------------------------------------------------ Google sign-in + YouTube Data API

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/youtube";
const YT_API = "https://www.googleapis.com/youtube/v3";

const gauth = {
  clientId() { return store.get("google.clientId") || state.config.google_client_id || null; },
  token() {
    const t = store.get("google.token");
    return t && t.expires_at - Date.now() > 60_000 ? t.access_token : null;
  },
  account() { return store.get("google.account"); },
  signedIn() { return !!this.token(); },

  async signIn() {
    if (!this.clientId()) {
      showGoogleSetup();
      return false;
    }
    for (let i = 0; i < 50 && !window.google?.accounts?.oauth2; i++) await sleep(100);
    if (!window.google?.accounts?.oauth2) {
      flash("Google sign-in didn't load. Check your connection or ad blocker, then reload the page.");
      return false;
    }
    const resp = await new Promise((resolve) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: this.clientId(),
        scope: GOOGLE_SCOPE,
        callback: resolve,
        error_callback: (err) => resolve({ error: err?.type || "failed", error_description: err?.message }),
      });
      client.requestAccessToken();
    });
    if (resp.error || !resp.access_token) {
      const msg = {
        popup_closed: "Google sign-in was closed before it finished. If Google said “Access blocked”, add the Gmail address you signed in with as a test user (Google Auth Platform › Audience › Test users), wait a minute, then try again.",
        popup_failed_to_open: "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.",
        access_denied: "Google sign-in was cancelled. If Google said “Access blocked”, add the Gmail address you signed in with as a test user (Google Auth Platform › Audience › Test users), then try again.",
      }[resp.error] || `Google sign-in failed: ${resp.error_description || resp.error}`;
      flash(msg);
      return false;
    }
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, GOOGLE_SCOPE)) {
      flash("Dubdeck needs permission to manage your YouTube playlists. Sign in again and tick the YouTube box.");
      return false;
    }
    store.set("google.token", { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000 });
    try {
      const data = await ytApi("GET", "/channels", { params: { part: "snippet", mine: "true" } });
      const ch = data.items?.[0];
      store.set("google.account", { name: ch?.snippet?.title || "Google account", hasChannel: !!ch });
    } catch {
      store.set("google.account", { name: "Google account", hasChannel: null });
    }
    renderDecks();
    renderActionBar();
    return true;
  },

  signOut() {
    const t = store.get("google.token");
    if (t?.access_token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.access_token, () => {});
    store.del("google.token");
    store.del("google.account");
    renderDecks();
    renderActionBar();
  },
};

async function ytApi(method, path, { params, body } = {}) {
  const token = gauth.token();
  if (!token) throw new HttpError("Your Google sign-in expired.", 401, "authError");
  const url = `${YT_API}${path}${params ? "?" + new URLSearchParams(params) : ""}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new HttpError("Lost the connection to YouTube.", 0, "network");
  }
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.details?.[0]?.reason || "";
    throw new HttpError(data?.error?.message || `YouTube returned ${res.status}`, res.status, reason);
  }
  return data;
}

const TRANSIENT = new Set(["network", "backendError", "rateLimitExceeded", "userRateLimitExceeded", "internalError"]);

async function withRetry(fn, { retryPlaylistNotFound = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const transient = TRANSIENT.has(e.reason) || e.status === 0 || e.status >= 500 || (retryPlaylistNotFound && e.reason === "playlistNotFound");
      if (!transient || attempt >= 3) throw e;
      await sleep(1500 * 2 ** attempt);
    }
  }
}

const yt = {
  async createPlaylist(title, description, privacy) {
    const data = await ytApi("POST", "/playlists", {
      params: { part: "snippet,status" },
      body: {
        snippet: { title: title.replace(/[<>]/g, "").slice(0, 150) || "Imported from Spotify", description: description.replace(/[<>]/g, "").slice(0, 4900) },
        status: { privacyStatus: privacy.toLowerCase() },
      },
    });
    return data.id;
  },
  addItem(playlistId, videoId) {
    return ytApi("POST", "/playlistItems", {
      params: { part: "snippet" },
      body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
    });
  },
  like(videoId) {
    return ytApi("POST", "/videos/rate", { params: { id: videoId, rating: "like" } });
  },
};

function friendlyYtError(e) {
  const r = e.reason || "";
  if (r === "youtubeSignupRequired" || r === "channelNotFound" || r === "channelClosed")
    return "Your Google account needs a YouTube channel before it can have playlists. Create one at youtube.com/create_channel, then press Continue transfer.";
  if (r === "accessNotConfigured" || r === "SERVICE_DISABLED")
    return "The YouTube Data API isn't turned on for this Google project. Turn it on in the Google Cloud console, then press Continue transfer.";
  if (r === "insufficientPermissions" || r === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    return "Dubdeck doesn't have permission to manage your YouTube playlists. Sign out, sign in again and allow YouTube access.";
  if (r === "playlistContainsMaximumNumOfVideos") return "This playlist is full: YouTube allows up to 5,000 songs per playlist.";
  return e.message;
}

// ------------------------------------------------------------------ cassette deck

function cassetteMarkup(k) {
  const teeth = [0, 60, 120, 180, 240, 300]
    .map((a) => `<rect class="c-tooth" x="-1.6" y="-7.2" width="3.2" height="3" transform="rotate(${a})"/>`)
    .join("");
  const hub = (x) => `
    <g transform="translate(${x} 88)">
      <g class="c-spin">
        <circle class="c-hub-ring" r="10.5"/>
        <circle class="c-hub-core" r="7"/>
        ${teeth}
      </g>
    </g>`;
  return `
  <svg class="cassette" viewBox="0 0 300 190" aria-hidden="true" focusable="false">
    <defs><clipPath id="win-${k}"><rect x="72" y="66" width="156" height="44" rx="7"/></clipPath></defs>
    <rect class="c-shell" x="2" y="2" width="296" height="186" rx="14"/>
    <circle class="c-screw" cx="15" cy="15" r="4"/><circle class="c-screw" cx="285" cy="15" r="4"/>
    <circle class="c-screw" cx="15" cy="175" r="4"/><circle class="c-screw" cx="285" cy="175" r="4"/>
    <rect class="c-label" x="20" y="14" width="260" height="114" rx="6"/>
    <rect class="c-stripe-1" x="20" y="96" width="260" height="6"/>
    <rect class="c-stripe-2" x="20" y="104" width="260" height="6"/>
    <text class="c-side" x="32" y="52">A</text>
    <text class="c-title" x="62" y="50" id="label-${k}"></text>
    <rect class="c-window" x="72" y="66" width="156" height="44" rx="7"/>
    <g clip-path="url(#win-${k})">
      <circle class="c-tape" id="pack-l-${k}" cx="112" cy="88" r="34"/>
      <circle class="c-tape" id="pack-r-${k}" cx="188" cy="88" r="12"/>
    </g>
    ${hub(112)}${hub(188)}
    <path class="c-bottom" d="M68 188 L82 146 H218 L232 188 Z"/>
    <circle class="c-hole" cx="104" cy="170" r="5"/><circle class="c-hole" cx="196" cy="170" r="5"/>
    <rect class="c-hole" x="138" y="160" width="9" height="8" rx="1.5"/><rect class="c-hole" x="153" y="160" width="9" height="8" rx="1.5"/>
  </svg>`;
}

function mountCassettes() {
  for (const k of ["a", "b"]) $(`[data-cassette="${k}"]`).innerHTML = cassetteMarkup(k);
  resetDeck();
}

function setLabels(a, b) {
  $("#label-a").textContent = clip(a, 20);
  $("#label-b").textContent = clip(b, 20);
}

function setTape(p, running) {
  p = Math.max(0, Math.min(1, p || 0));
  const left = 12 + 22 * Math.sqrt(1 - p);
  const right = 12 + 22 * Math.sqrt(p);
  for (const k of ["a", "b"]) {
    const l = $(`#pack-l-${k}`), r = $(`#pack-r-${k}`);
    l.style.r = `${left}px`; l.setAttribute("r", left);
    r.style.r = `${right}px`; r.setAttribute("r", right);
  }
  $("#deck").classList.toggle("running", !!running);
}

function setCounter(n) {
  const s = String(Math.min(n || 0, 9999)).padStart(4, "0");
  $$("#counter span").forEach((el, i) => (el.textContent = s[i]));
  $("#counter").setAttribute("aria-label", `${n || 0} songs processed`);
}

const setTransport = (text) => ($("#transport-status").textContent = text);

function resetDeck() {
  setCounter(0);
  setTape(0, false);
  setTransport("Ready");
  setLabels("Spotify", "YouTube Music");
}

function renderDecks() {
  const songs = state.library.reduce((a, p) => a + p.tracks.length, 0);
  $("#bay-a").dataset.state = state.library.length ? "on" : "off";
  $("#acct-a").textContent = state.library.length ? `${plural(state.library.length, "playlist")}, ${plural(songs, "song")}` : "Nothing added yet";
  const on = gauth.signedIn();
  $("#bay-b").dataset.state = on ? "on" : "off";
  $("#acct-b").textContent = on ? gauth.account()?.name || "Signed in" : "Not signed in";
  $("#yt-auth").textContent = on ? "Sign out" : "Sign in";
}

$("#yt-auth").addEventListener("click", () => (gauth.signedIn() ? gauth.signOut() : gauth.signIn()));

// ------------------------------------------------------------------ views

const STEP_OF = { add: 0, import: 0, working: 1, review: 1, transferring: 2, done: 2 };

function show(view) {
  const id = { import: "working", transferring: "working" }[view] || view;
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${id}`));
  const current = STEP_OF[view === "working" && state.run?.kind === "import" ? "import" : view];
  $$("#steps li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("done", n < current);
    if (n === current) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  state.view = view;
  renderActionBar();
}

function flash(msg) {
  $("#flash-text").textContent = msg;
  $("#flash").hidden = false;
  $("#flash").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function clearFlash() { $("#flash").hidden = true; }
$("#flash-close").addEventListener("click", clearFlash);

function showGoogleSetup() {
  $("#g-origin").textContent = location.origin;
  $("#google-setup").hidden = false;
  $("#google-setup").scrollIntoView({ block: "start", behavior: "smooth" });
}
$("#copy-origin").addEventListener("click", (e) => copyText(location.origin, e.currentTarget));
$("#form-google").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#google-client-id").value.trim();
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) {
    flash("That doesn't look like a Google client ID. It ends in .apps.googleusercontent.com.");
    return;
  }
  store.set("google.clientId", id);
  $("#google-setup").hidden = true;
  clearFlash();
  gauth.signIn();
});

function renderActionBar() {
  const bar = $("#actionbar"), btn = $("#action-btn"), sum = $("#action-summary");
  btn.replaceChildren();
  btn.disabled = false;
  if (state.view === "add") {
    const chosen = state.library.filter((p) => state.selected.has(p.uid));
    const songs = chosen.reduce((a, p) => a + p.tracks.length, 0);
    bar.hidden = !state.library.length;
    sum.replaceChildren(
      chosen.length ? h("span", {}, h("strong", { text: plural(chosen.length, "playlist") }), ` selected, ${plural(songs, "song")}`) : "Tick the playlists you want to copy."
    );
    btn.append("Find matches");
    btn.disabled = !chosen.length;
    btn.onclick = startMatch;
  } else if (state.view === "review" && state.review) {
    const pls = state.review.playlists.filter((pl) => pl.tracks.some((t) => t.sel && t.pick));
    const n = state.review.playlists.reduce((a, pl) => a + new Set(pl.tracks.filter((t) => t.sel && t.pick).map((t) => t.pick.videoId)).size, 0);
    bar.hidden = false;
    const days = Math.ceil((n + pls.length) / 195);
    sum.replaceChildren(
      n
        ? h("span", {},
            h("strong", { text: plural(n, "song") }), ` ready to go into ${plural(pls.length, "playlist")}.`,
            days > 1 ? ` Google allows about 200 a day, so this takes about ${days} days. Progress is saved between days.` : "")
        : "No songs are selected."
    );
    if (gauth.signedIn()) {
      btn.append(h("span", { class: "rec-dot", "aria-hidden": "true" }), "Transfer to YouTube Music");
      btn.onclick = startTransfer;
    } else {
      btn.append("Sign in with Google to transfer");
      btn.onclick = () => gauth.signIn();
    }
    btn.disabled = !n;
  } else {
    bar.hidden = true;
  }
}

async function copyText(text, btn) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { class: "sr-only" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = old), 1600);
}

// ------------------------------------------------------------------ shelf

const heart = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.6 1.1 5.2 3 1.6-1.9 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z"/>';
  return s;
};

function coverFor(p) {
  if (p.liked) return h("span", { class: "tape-cover liked" }, heart());
  if (p.image) return h("img", { class: "tape-cover", src: p.image, alt: "", loading: "lazy" });
  return h("span", { class: "tape-cover" });
}

const SOURCE_TEXT = { paste: "pasted", playlist: "from a playlist link", album: "album", file: "from a file", export: "from Spotify's data download" };

function renderShelf() {
  const has = state.library.length > 0;
  $("#shelf-tools").hidden = !has;
  $("#shelf-lede").textContent = has ? "Tick the playlists to copy. Each becomes a new playlist on YouTube Music." : "Playlists you add show up here.";
  const q = $("#pl-filter").value.trim().toLowerCase();
  const items = state.library.filter((p) => !q || p.name.toLowerCase().includes(q));
  const list = $("#pl-list");
  if (!has) list.replaceChildren();
  else if (!items.length) list.replaceChildren(h("li", { class: "shelf-empty", text: "No playlists match that filter." }));
  else list.replaceChildren(...items.map(shelfItem));
  renderDecks();
  renderActionBar();
}

function shelfItem(p) {
  const id = `pl-${p.uid}`;
  const meta = [plural(p.tracks.length, "song"), p.owner && p.source !== "paste" ? `by ${p.owner}` : null, SOURCE_TEXT[p.source]].filter(Boolean).join(", ");
  return h("li", {},
    h("label", { class: "tape", for: id },
      h("input", {
        type: "checkbox", id, class: "sr-only", checked: state.selected.has(p.uid),
        onchange: (e) => { e.target.checked ? state.selected.add(p.uid) : state.selected.delete(p.uid); saveLibrary(); renderActionBar(); },
      }),
      coverFor(p),
      h("span", { class: "tape-body" },
        h("span", { class: "tape-name", text: p.name }),
        h("span", { class: "tape-meta" }, meta, p.note ? h("span", { class: "note", text: `. ${p.note}` }) : null)
      ),
      h("span", { class: "led", "aria-hidden": "true" })
    ),
    h("button", {
      type: "button", class: "tape-remove", "aria-label": `Remove ${p.name}`,
      onclick: () => { state.library = state.library.filter((x) => x.uid !== p.uid); state.selected.delete(p.uid); saveLibrary(); renderShelf(); },
    }, "Remove")
  );
}

$("#pl-filter").addEventListener("input", renderShelf);
$("#pl-all").addEventListener("click", () => {
  const q = $("#pl-filter").value.trim().toLowerCase();
  const visible = state.library.filter((p) => !q || p.name.toLowerCase().includes(q));
  const allOn = visible.every((p) => state.selected.has(p.uid));
  visible.forEach((p) => (allOn ? state.selected.delete(p.uid) : state.selected.add(p.uid)));
  saveLibrary();
  renderShelf();
});
$("#pl-clear").addEventListener("click", (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed !== "1") {
    b.dataset.armed = "1";
    b.textContent = "Click again to remove all";
    setTimeout(() => { b.dataset.armed = "0"; b.textContent = "Remove all"; }, 3000);
    return;
  }
  b.dataset.armed = "0";
  b.textContent = "Remove all";
  state.library = [];
  state.selected.clear();
  saveLibrary();
  renderShelf();
});

// ------------------------------------------------------------------ running work

function setWork(title, lede) {
  $("#work-title").textContent = title;
  $("#work-lede").textContent = lede;
  $("#work-label").textContent = "Starting…";
  $("#work-bar i").style.width = "0%";
}

function tick({ label, done, total, verb }) {
  const p = total ? done / total : 0;
  setCounter(done);
  setTape(p, true);
  setTransport(total ? `${done.toLocaleString()} of ${total.toLocaleString()}` : verb || "Working…");
  if (label) $("#work-label").textContent = label;
  $("#work-bar i").style.width = `${Math.round(p * 100)}%`;
  $("#work-bar").setAttribute("aria-valuenow", Math.round(p * 100));
}

$("#work-stop").addEventListener("click", (e) => {
  if (!state.run) return;
  state.run.cancelled = true;
  e.currentTarget.disabled = true;
  e.currentTarget.textContent = "Stopping…";
});

function beginRun(kind) {
  state.run = { kind, cancelled: false };
  const b = $("#work-stop");
  b.disabled = false;
  b.textContent = "Stop";
}

window.addEventListener("beforeunload", (e) => {
  if (state.run) { e.preventDefault(); e.returnValue = ""; }
});

// ------------------------------------------------------------------ matching

const trackKey = (t) => t.id || `${t.title}|${t.artists.join(",")}`;

async function startMatch() {
  clearFlash();
  const pls = state.library.filter((p) => state.selected.has(p.uid));
  if (!pls.length) return;
  beginRun("match");
  setWork("Finding your songs on YouTube Music", "Each song is matched by title, artist and length (and by its recording code when the file has one). Keep this tab open.");
  setLabels(pls.length === 1 ? pls[0].name : `${pls.length} playlists`, "YouTube Music");
  show("working");

  const rows = pls.map((p) => new Array(p.tracks.length));
  const pending = [];
  let done = 0;
  pls.forEach((p, pi) => p.tracks.forEach((t, ti) => {
    const hit = matchCache.get(trackKey(t));
    if (hit) { rows[pi][ti] = { spotify: t, ...hit }; done++; }
    else pending.push({ pi, ti, t });
  }));
  const total = done + pending.length;
  tick({ label: "Finding songs on YouTube Music…", done, total });

  const worker = async () => {
    while (pending.length && !state.run.cancelled) {
      const batch = pending.splice(0, 6);
      let results;
      for (let attempt = 0; ; attempt++) {
        try {
          results = (await api("/api/ytm/match", { method: "POST", body: { tracks: batch.map((b) => b.t), region } })).results;
          break;
        } catch (err) {
          if (attempt < 2 && (err.status === 0 || err.status >= 500)) { await sleep(1500 * (attempt + 1)); continue; }
          results = batch.map(() => ({ match: null, candidates: [], error: err.message }));
          break;
        }
      }
      batch.forEach((b, k) => {
        const r = results[k];
        rows[b.pi][b.ti] = { spotify: b.t, ...r };
        if (!r.error) matchCache.set(trackKey(b.t), r);
      });
      done += batch.length;
      tick({ label: `Matching “${pls[batch[0].pi].name}”…`, done, total });
    }
  };
  await Promise.all([worker(), worker()]);
  const cancelled = state.run.cancelled;
  state.run = null;

  const playlists = pls.map((p, pi) => ({
    name: p.name, description: p.description, image: p.image, liked: p.liked,
    tracks: p.tracks.map((t, ti) => rows[pi][ti] || { spotify: t, match: null, candidates: [], error: "Stopped before this song was matched." }),
  }));
  setTape(1, false);
  setTransport(cancelled ? "Stopped" : "Matched");
  setLabels("Spotify", "YouTube Music");
  loadReview(playlists);
  show("review");
}

// ------------------------------------------------------------------ review

function category(t) {
  if (!t.pick) return "missing";
  if (t.pick.confidence === "high" || t.pick.confidence === "manual") return "ok";
  return "review";
}

function inFilter(t) {
  switch (state.filter) {
    case "review": return category(t) === "review";
    case "missing": return category(t) === "missing";
    case "skipped": return !!t.pick && !t.sel;
    default: return true;
  }
}

function loadReview(playlists) {
  const many = playlists.length > 1;
  state.review = {
    playlists: playlists.map((pl) => ({
      ...pl,
      outName: pl.liked ? "Liked Songs from Spotify" : pl.name,
      privacy: "PRIVATE",
      mode: "playlist",
      collapsed: many && pl.tracks.length > 60,
      tracks: pl.tracks.map((t) => ({ ...t, pick: t.match, sel: !!t.match && t.match.confidence !== "low" })),
    })),
  };
  state.transfer = null;
  store.del("transfer");
  state.filter = "all";
  state.openAlt = null;
  state.shown = {};
  saveReview(true);
  renderReview();
}

let saveTimer;
function saveReview(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    if (state.review && !store.set("review", state.review)) store.del("review");
  };
  if (now) write();
  else saveTimer = setTimeout(write, 300);
}

function counts(tracks) {
  const c = { all: tracks.length, ok: 0, review: 0, missing: 0, skipped: 0, selected: 0 };
  for (const t of tracks) {
    c[category(t)]++;
    if (t.pick && !t.sel) c.skipped++;
    if (t.pick && t.sel) c.selected++;
  }
  return c;
}

function renderFilterCounts() {
  const c = counts(state.review.playlists.flatMap((pl) => pl.tracks));
  $("#n-all").textContent = c.all.toLocaleString();
  $("#n-review").textContent = c.review.toLocaleString();
  $("#n-missing").textContent = c.missing.toLocaleString();
  $("#n-skipped").textContent = c.skipped.toLocaleString();
  $$("#filters button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter)));
}

$$("#filters button").forEach((b) =>
  b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    state.openAlt = null;
    state.shown = {};
    renderReview();
  })
);

$("#back-to-add").addEventListener("click", goAdd);

function renderReview() {
  renderFilterCounts();
  $("#review-list").replaceChildren(...state.review.playlists.map((pl, pi) => jcard(pl, pi)));
  renderActionBar();
}

function statsLine(pl) {
  const c = counts(pl.tracks);
  return [
    h("span", {}, h("span", { class: "led on", "aria-hidden": "true" }), `${c.selected.toLocaleString()} of ${plural(c.all, "song")} selected`),
    c.review ? h("span", {}, h("span", { class: "led amber", "aria-hidden": "true" }), `${c.review} to check`) : null,
    c.missing ? h("span", {}, h("span", { class: "led rec", "aria-hidden": "true" }), `${c.missing} not found`) : null,
  ];
}

function jcard(pl, pi) {
  const nameId = `pl-name-${pi}`, privId = `pl-priv-${pi}`, modeId = `pl-mode-${pi}`;
  const stats = h("div", { class: "jcard-stats" }, statsLine(pl));

  const privacy = h("select", { id: privId, onchange: (e) => { pl.privacy = e.target.value; saveReview(); } },
    ...[["PRIVATE", "Private"], ["UNLISTED", "Unlisted"], ["PUBLIC", "Public"]].map(([v, l]) => h("option", { value: v, selected: pl.privacy === v }, l))
  );
  const opts = h("div", { class: "jcard-opts" });
  if (pl.liked) {
    const mode = h("select", {
      id: modeId,
      onchange: (e) => { pl.mode = e.target.value; privField.hidden = pl.mode === "like"; nameInput.disabled = pl.mode === "like"; saveReview(); },
    },
      h("option", { value: "playlist", selected: pl.mode === "playlist" }, "Make a playlist"),
      h("option", { value: "like", selected: pl.mode === "like" }, "Like each song")
    );
    opts.append(h("div", { class: "field" }, h("label", { for: modeId, text: "On YouTube Music" }), mode));
  }
  const privField = h("div", { class: "field", hidden: pl.mode === "like" }, h("label", { for: privId, text: "Visibility" }), privacy);
  opts.append(privField);
  opts.append(h("button", {
    type: "button", class: "key key-small", "aria-expanded": String(!pl.collapsed),
    onclick: () => { pl.collapsed = !pl.collapsed; saveReview(); card.replaceWith(jcard(pl, pi)); },
  }, pl.collapsed ? "Show songs" : "Hide songs"));

  const nameInput = h("input", {
    type: "text", id: nameId, value: pl.outName, maxlength: "150", disabled: pl.mode === "like",
    oninput: (e) => { pl.outName = e.target.value; saveReview(); },
  });

  const head = h("header", { class: "jcard-head" },
    coverFor(pl),
    h("div", { class: "jcard-title" }, h("label", { class: "label", for: nameId, text: `New playlist name (from “${pl.name}”)` }), nameInput, stats),
    opts
  );
  const card = h("section", { class: "jcard", "aria-label": pl.name }, head);
  if (!pl.collapsed) card.append(trackList(pl, pi, stats));
  return card;
}

const PAGE = 150;

function trackList(pl, pi, stats) {
  const ol = h("ol", { class: "tracks" });
  const rows = pl.tracks.map((t, ti) => [t, ti]).filter(([t]) => inFilter(t));
  const limit = state.shown[pi] || PAGE;
  const frag = document.createDocumentFragment();
  for (const [t, ti] of rows.slice(0, limit)) {
    frag.append(trackRow(pl, pi, t, ti, stats));
    if (state.openAlt === `${pi}:${ti}`) frag.append(altsRow(pl, pi, t, ti));
  }
  ol.append(frag);
  const wrap = h("div", {}, ol);
  if (!rows.length) wrap.append(h("p", { class: "empty-filter", text: "Nothing here for this filter." }));
  if (rows.length > limit) {
    wrap.append(h("div", { class: "more-row" },
      h("button", {
        type: "button", class: "key key-small",
        onclick: () => { state.shown[pi] = limit + PAGE * 4; wrap.replaceWith(trackList(pl, pi, stats)); },
      }, `Show ${Math.min(rows.length - limit, PAGE * 4)} more of ${rows.length - limit}`)
    ));
  }
  return wrap;
}

function meter(cand) {
  if (!cand) return h("span", { class: "meter", "aria-hidden": "true" });
  const lit = cand.confidence === "manual" ? 5 : Math.max(1, Math.round(cand.score * 5));
  const label = cand.confidence === "manual" ? "Chosen by you" : `${Math.round(cand.score * 100)}% match`;
  return h("span", { class: `meter ${cand.confidence}`, role: "img", "aria-label": label, title: label },
    ...[1, 2, 3, 4, 5].map((i) => h("i", { class: i <= lit ? "lit" : null }))
  );
}

function durCell(t, cand) {
  if (!cand) return h("span", { class: "dur" });
  const diff = cand.duration && t.spotify.duration_sec ? Math.round(cand.duration - t.spotify.duration_sec) : 0;
  return h("span", { class: "dur", title: t.spotify.duration_sec ? `Spotify ${fmtTime(t.spotify.duration_sec)}` : null },
    fmtTime(cand.duration),
    Math.abs(diff) >= 8 ? h("span", { class: "off-by", text: `${diff > 0 ? "+" : "−"}${fmtTime(Math.abs(diff))}` }) : null
  );
}

function trackRow(pl, pi, t, ti, stats) {
  const sp = t.spotify, c = t.pick;
  const key = `${pi}:${ti}`;
  const spUrl = sp.id ? `https://open.spotify.com/track/${sp.id}` : null;
  const sideA = h("div", { class: "side side-a" },
    spUrl ? h("a", { class: "t-title", href: spUrl, target: "_blank", rel: "noopener", text: sp.title }) : h("span", { class: "t-title", text: sp.title }),
    h("span", { class: "t-sub", text: sp.artists.join(", ") })
  );
  const sideB = c
    ? h("div", { class: "side side-b" },
        c.thumbnail ? h("img", { class: "thumb", src: c.thumbnail, alt: "", loading: "lazy" }) : h("span", { class: "thumb" }),
        h("div", {},
          h("a", { class: "t-title", href: `https://music.youtube.com/watch?v=${c.videoId}`, target: "_blank", rel: "noopener", text: c.title }),
          h("span", { class: "t-sub" }, c.artists || (c.type === "video" ? "Video" : ""), c.album ? h("span", { class: "album", text: c.album }) : null)
        )
      )
    : h("p", { class: "missing-note", text: t.error ? `Search failed: ${t.error}` : "No match found. Use Change to paste a link." });

  const li = h("li", { class: `track${t.sel && c ? "" : " off"}` },
    h("input", {
      type: "checkbox", checked: t.sel && !!c, disabled: !c, "aria-label": `Include ${sp.title}`,
      onchange: (e) => { t.sel = e.target.checked; refreshRow(); },
    }),
    h("span", { class: "num", text: String(ti + 1).padStart(2, "0") }),
    sideA,
    meter(c),
    sideB,
    durCell(t, c),
    h("button", {
      type: "button", class: "key key-small key-ghost", "aria-expanded": String(state.openAlt === key),
      onclick: () => { state.openAlt = state.openAlt === key ? null : key; refreshRow(true); },
    }, state.openAlt === key ? "Close" : "Change")
  );

  function refreshRow(toggledAlt = false) {
    saveReview();
    const next = li.nextElementSibling;
    if (next && next.classList.contains("alts")) next.remove();
    const fresh = trackRow(pl, pi, t, ti, stats);
    li.replaceWith(fresh);
    if (state.openAlt === key) {
      const alt = altsRow(pl, pi, t, ti);
      fresh.after(alt);
      if (toggledAlt) alt.querySelector("input")?.focus();
    }
    stats.replaceChildren(...statsLine(pl));
    renderFilterCounts();
    renderActionBar();
  }
  li._refresh = refreshRow;
  return li;
}

function altsRow(pl, pi, t, ti) {
  const name = `alt-${pi}-${ti}`;
  const choose = (cand) => {
    t.pick = cand;
    t.sel = !!cand;
    box.previousElementSibling?._refresh?.();
  };
  const cands = [...t.candidates];
  if (t.pick && !cands.some((c) => c.videoId === t.pick.videoId)) cands.unshift(t.pick);

  const options = cands.map((c, i) =>
    h("label", { class: "alt", for: `${name}-${i}` },
      h("input", { type: "radio", name, id: `${name}-${i}`, checked: t.pick?.videoId === c.videoId, onchange: () => choose(c) }),
      c.thumbnail ? h("img", { class: "thumb", src: c.thumbnail, alt: "", loading: "lazy" }) : h("span", { class: "thumb" }),
      h("span", { class: "side" },
        h("span", { class: "t-title", text: c.title }),
        h("span", { class: "t-sub" }, [c.artists, c.album, c.type === "video" ? "music video" : null].filter(Boolean).join(", "))
      ),
      meter(c),
      durCell(t, c)
    )
  );
  options.push(
    h("label", { class: "alt none", for: `${name}-none` },
      h("input", { type: "radio", name, id: `${name}-none`, checked: !t.pick, onchange: () => choose(null) }),
      h("span", { class: "t-sub", text: "Leave this song out" })
    )
  );

  const urlId = `${name}-url`;
  const form = h("form", { class: "inline-form", autocomplete: "off" },
    h("div", { class: "field" }, h("label", { for: urlId, text: "Or paste a YouTube Music or YouTube link" }),
      h("input", { type: "url", id: urlId, placeholder: "https://music.youtube.com/watch?v=…", required: true })),
    h("button", { class: "key key-small", type: "submit" }, "Use this link")
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Looking up…";
    try {
      const { candidate } = await api("/api/ytm/lookup", { method: "POST", body: { url: form.querySelector("input").value } });
      choose(candidate);
    } catch (err) {
      flash(err.message);
      btn.disabled = false;
      btn.textContent = "Use this link";
    }
  });

  const box = h("li", { class: "alts" },
    h("fieldset", { class: "alts-list" }, h("legend", { class: "sr-only", text: `Matches for ${t.spotify.title}` }), ...options),
    form
  );
  return box;
}

// ------------------------------------------------------------------ transfer (resumable)

function saveTransfer() {
  store.set("transfer", state.transfer);
}

async function startTransfer() {
  clearFlash();
  const items = [];
  state.review.playlists.forEach((pl, pi) => {
    const all = pl.tracks.filter((t) => t.sel && t.pick).map((t) => t.pick.videoId);
    if (!all.length) return;
    const ids = [...new Set(all)];
    items.push({
      pi,
      name: (pl.outName || pl.name).trim() || pl.name,
      description: [pl.description, "Copied from Spotify with Dubdeck."].filter(Boolean).join("\n\n"),
      privacy: pl.privacy,
      mode: pl.mode,
      ids,
      dupes: all.length - ids.length,
      playlistId: null,
      url: pl.mode === "like" ? "https://music.youtube.com/playlist?list=LM" : null,
      next: 0,
      added: 0,
      failed: [],
    });
  });
  if (!items.length) return;
  state.transfer = { status: "running", reason: null, message: null, items };
  saveTransfer();
  runTransfer();
}

const SKIPPABLE = new Set(["videoNotFound", "forbidden", "videoNotAvailable", "videoChartNotFound", "invalidVideoId", "videoRatingDisabled", "notFound"]);

async function runTransfer() {
  const T = state.transfer;
  if (!gauth.signedIn() && !(await gauth.signIn())) {
    T.status = "paused";
    T.reason = "auth";
    saveTransfer();
    return renderDone();
  }
  T.status = "running";
  T.reason = T.message = null;
  saveTransfer();
  beginRun("transfer");
  setWork("Writing playlists to YouTube Music", "Songs are added one at a time through YouTube's official API. Keep this tab open.");
  const first = T.items.find((it) => it.next < it.ids.length) || T.items[0];
  setLabels("Spotify", T.items.length === 1 ? first.name : `${T.items.length} playlists`);
  show("transferring");

  const total = T.items.reduce((a, it) => a + it.ids.length, 0);
  let done = T.items.reduce((a, it) => a + it.next, 0);

  outer: for (const it of T.items) {
    if (it.mode === "playlist" && !it.playlistId && it.next < it.ids.length) {
      if (state.run.cancelled) { T.status = "stopped"; break; }
      tick({ label: `Creating playlist “${it.name}”…`, done, total });
      try {
        it.playlistId = await withRetry(() => yt.createPlaylist(it.name, it.description, it.privacy));
        it.url = `https://music.youtube.com/playlist?list=${it.playlistId}`;
        saveTransfer();
      } catch (e) {
        if (e.reason === "quotaExceeded") { T.status = "paused"; T.reason = "quota"; break; }
        if (e.status === 401) { T.status = "paused"; T.reason = "auth"; break; }
        T.status = "error";
        T.message = friendlyYtError(e);
        break;
      }
    }
    while (it.next < it.ids.length) {
      if (state.run.cancelled) { T.status = "stopped"; break outer; }
      const vid = it.ids[it.next];
      tick({ label: `${it.mode === "like" ? "Liking songs for" : "Adding songs to"} “${it.name}”…`, done, total });
      try {
        if (it.mode === "like") await withRetry(() => yt.like(vid));
        else await withRetry(() => yt.addItem(it.playlistId, vid), { retryPlaylistNotFound: it.added === 0 });
        it.added++;
      } catch (e) {
        if (e.reason === "quotaExceeded") { T.status = "paused"; T.reason = "quota"; break outer; }
        if (e.status === 401) { T.status = "paused"; T.reason = "auth"; break outer; }
        if (SKIPPABLE.has(e.reason)) {
          it.failed.push(vid);
        } else if (e.status === 0 || e.status >= 500 || TRANSIENT.has(e.reason)) {
          T.status = "paused"; T.reason = "network"; break outer;
        } else {
          T.status = "error"; T.message = friendlyYtError(e); break outer;
        }
      }
      it.next++;
      done++;
      saveTransfer();
    }
  }
  if (T.status === "running") T.status = "done";
  saveTransfer();
  state.run = null;
  setTape(T.status === "done" ? 1 : total ? done / total : 0, false);
  setTransport({ done: "Done", paused: "Paused", stopped: "Stopped" }[T.status] || "Error");
  renderDone();
}

function untilQuotaReset() {
  const now = new Date();
  const pt = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 0, 0);
  const ms = midnight - pt;
  const at = new Date(now.getTime() + ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return { hours: Math.max(1, Math.round(ms / 3_600_000)), at };
}

function renderDone() {
  const T = state.transfer;
  if (!T) return goAdd();
  if (T.status === "running" && !state.run) { T.status = "paused"; T.reason = "interrupted"; saveTransfer(); }
  const total = T.items.reduce((a, it) => a + it.ids.length, 0);
  const added = T.items.reduce((a, it) => a + it.added, 0);
  const processed = T.items.reduce((a, it) => a + it.next, 0);
  setCounter(added);

  $("#done-title").textContent = { done: "Transfer finished", paused: "Transfer paused", stopped: "Transfer stopped" }[T.status] || "Transfer stopped early";
  $("#done-lede").textContent = `${added.toLocaleString()} of ${plural(total, "song")} added to YouTube Music.${T.status === "done" ? " Playlists can take a minute to appear in your library." : ""}`;

  const unfinished = processed < total || T.items.some((it) => it.mode === "playlist" && !it.playlistId && it.ids.length);
  $("#paused").hidden = !unfinished;
  if (unfinished) {
    let text;
    if (T.reason === "quota") {
      const { hours, at } = untilQuotaReset();
      text = `Google's daily limit for this app is used up. It resets at midnight Pacific time, in about ${plural(hours, "hour")} (around ${at} your time). Your progress is saved in this browser: come back then and press Continue transfer.`;
    } else if (T.reason === "auth") text = "Sign in with Google to carry on. Press Continue transfer.";
    else if (T.reason === "network") text = "Lost the connection to YouTube. Press Continue transfer to retry from where it stopped.";
    else if (T.reason === "interrupted") text = "The page was closed during the transfer. Press Continue transfer to pick up where it stopped.";
    else if (T.status === "stopped") text = "You stopped the transfer. Press Continue transfer to carry on.";
    else text = `${T.message || "Something went wrong."} Press Continue transfer to try again.`;
    $("#paused-text").textContent = text;
  }

  $("#results").replaceChildren(
    ...T.items.map((it) => {
      const pl = state.review?.playlists[it.pi];
      const failed = new Set(it.failed);
      const pending = new Set(it.ids.slice(it.next));
      const missed = pl
        ? pl.tracks.filter((t) => !t.pick || !t.sel || failed.has(t.pick.videoId)).map((t) => `${t.spotify.artists.join(", ")} - ${t.spotify.title}`)
        : [];
      const meta = it.mode === "like"
        ? `${plural(it.added, "song")} liked of ${it.ids.length.toLocaleString()}`
        : `${it.added.toLocaleString()} of ${plural(it.ids.length, "song")} added${it.dupes ? `, ${plural(it.dupes, "duplicate")} skipped` : ""}`;
      const panel = h("article", { class: "panel result" },
        h("div", { class: "result-head" },
          h("div", {}, h("p", { class: "result-name", text: it.name }), h("p", { class: "result-meta", text: pending.size ? `${meta}. ${plural(pending.size, "song")} still to go.` : meta })),
          it.url ? h("a", { class: "key key-primary", href: it.url, target: "_blank", rel: "noopener" }, it.mode === "like" ? "Open liked music" : "Open in YouTube Music") : null
        ),
        h("div", { class: "bar", role: "img", "aria-label": `${it.added} of ${it.ids.length} added` }, h("i", { style: `width:${it.ids.length ? Math.round((it.added / it.ids.length) * 100) : 0}%` }))
      );
      if (missed.length) {
        panel.append(
          h("details", {},
            h("summary", {}, `${plural(missed.length, "song")} won't make it over`),
            h("ol", { class: "missed" }, ...missed.map((m) => h("li", { text: m }))),
            h("button", { type: "button", class: "key key-small", onclick: (e) => copyText(missed.join("\n"), e.currentTarget) }, "Copy list")
          )
        );
      }
      return panel;
    })
  );
  show("done");
}

$("#resume").addEventListener("click", () => runTransfer());

$("#start-over").addEventListener("click", (e) => {
  const b = e.currentTarget;
  const T = state.transfer;
  const unfinished = T && T.items.some((it) => it.next < it.ids.length);
  if (unfinished && b.dataset.armed !== "1") {
    b.dataset.armed = "1";
    b.textContent = "Click again to drop the unfinished transfer";
    setTimeout(() => { b.dataset.armed = "0"; b.textContent = "Transfer more playlists"; }, 4000);
    return;
  }
  b.dataset.armed = "0";
  b.textContent = "Transfer more playlists";
  state.transfer = null;
  state.review = null;
  store.del("transfer");
  store.del("review");
  resetDeck();
  goAdd();
});

// ------------------------------------------------------------------ routing & boot

function goAdd() {
  show("add");
  renderShelf();
}

function route() {
  if (state.transfer && state.review) return renderDone();
  if (state.review) {
    const n = state.review.playlists.reduce((a, pl) => a + pl.tracks.length, 0);
    setCounter(n);
    setTape(1, false);
    setTransport("Matched");
    renderReview();
    return show("review");
  }
  goAdd();
}

async function boot() {
  mountCassettes();
  try {
    state.config = await api("/api/config");
  } catch (err) {
    flash(err.message);
  }
  renderDecks();
  route();
}

boot();
