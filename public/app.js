// Dubdeck front end. Plain JS, no build step.
//
// 1. Add playlists: paste a Spotify playlist, album or profile link (read via /api/spotify/*, no
//    login). For private playlists and Liked Songs: paste songs copied from the desktop app, or
//    upload an Exportify / TuneMyMusic CSV or Spotify data-download JSON.
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
const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
const etaText = (sec) => {
  if (sec < 50) return "Less than a minute left";
  const m = Math.round(sec / 60);
  return `About ${m < 60 ? plural(m, "minute") : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`} left`;
};
const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// A spreadsheet would run a cell starting with = + - @ as a formula, so those get a leading '.
const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ------------------------------------------------------------------ state

const state = {
  config: { google_client_id: null },
  library: store.get("library", []), // [{ uid, name, image, owner, liked, source, note, description, tracks }]
  selected: new Set(store.get("selected", [])),
  review: store.get("review"),
  transfer: store.get("transfer"),
  filter: "all",
  songQuery: "",
  openAlt: null,
  shown: {},
  run: null, // { kind, cancelled, t0, d0 } while importing / matching / transferring
  view: null,
  ytPlaylists: null, // the signed-in user's YouTube playlists, read once for "Send to"
};
const matchCache = new Map();

// Which YouTube playlist each Spotify playlist went to, so the next transfer can add only new songs.
const sentTo = {
  key: (pl) => (pl.liked ? "liked" : pl.sid ? `sp:${pl.sid}` : `name:${pl.name.trim().toLowerCase()}`),
  all: () => store.get("history", {}),
  get(pl) { return this.all()[this.key(pl)] || null; },
  put(key, entry) { const all = this.all(); all[key] = { ...entry, at: Date.now() }; store.set("history", all); },
  drop(key) { const all = this.all(); delete all[key]; store.set("history", all); },
};

function saveLibrary() {
  const ok = store.set("library", state.library);
  store.set("selected", [...state.selected]);
  if (!ok) flash("Your playlists are too big to save in this browser. They'll work now, but will be gone if you reload.");
}

// ------------------------------------------------------------------ importing: paste

const LINK_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|playlist|album)\/|spotify:(track|playlist|album):)([A-Za-z0-9]{22})/g;
const USER_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?user\/|spotify:user:)([^\s/?#:]+)/g;

function parsePaste(text) {
  const trackIds = [];
  const collections = [];
  for (const m of text.matchAll(LINK_RE)) {
    const kind = m[1] || m[2];
    if (kind === "track") trackIds.push(m[3]);
    else if (!collections.some((c) => c.id === m[3])) collections.push({ kind, id: m[3] });
  }
  const users = new Set();
  for (const m of text.matchAll(USER_RE)) {
    try { users.add(decodeURIComponent(m[1])); } catch { users.add(m[1]); }
  }
  const localFiles = (text.match(/spotify:local:|open\.spotify\.com\/local\//g) || []).length;
  return { trackIds, collections, users: [...users], localFiles };
}

// A library entry. `sid` is its Spotify id when it came from a link. `pending` means it came from
// a profile: we know its name and song count, and read the songs only when it's chosen for matching.
function libEntry(fields) {
  return {
    uid: uid(), name: "Untitled", image: null, owner: "", liked: false, source: "paste", note: null, description: "",
    sid: null, pending: false, count: null, tracks: [], ...fields,
  };
}

const songCount = (p) => (p.pending ? p.count || 0 : p.tracks.length);

function addToLibrary(entries, { select = true } = {}) {
  let n = 0;
  for (const e of entries) {
    if (!e.tracks.length && !e.pending) continue;
    const at = e.sid ? state.library.findIndex((x) => x.sid === e.sid) : -1;
    if (at >= 0) {
      if (e.pending) continue; // already on the shelf
      e.uid = state.library[at].uid; // a fresh read replaces the old copy and keeps its tick
      state.library[at] = e;
    } else {
      state.library.push(e);
    }
    if (select) state.selected.add(e.uid);
    n++;
  }
  saveLibrary();
  return n;
}

async function readCollection({ kind, id }) {
  const col = await api("/api/spotify/collection", { method: "POST", body: { kind, id } });
  return {
    name: col.name, image: col.image, owner: col.owner, source: kind, sid: col.id, description: col.description || "",
    tracks: col.tracks,
    note: col.maybe_truncated ? `Spotify only shared ${plural(col.tracks.length, "song")} from this one. Copy the rest from the desktop app.` : null,
  };
}

// Enter adds the link; Shift+Enter still makes a new line. Pasted lists keep their line breaks.
$("#paste-box").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#form-paste").requestSubmit();
  }
});

$("#form-paste").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFlash();
  const { trackIds, collections, users, localFiles } = parsePaste($("#paste-box").value);
  if (!trackIds.length && !collections.length && !users.length) {
    flash("No Spotify links found. Paste the link to a playlist, an album or your profile. It starts with https://open.spotify.com/");
    return;
  }
  beginRun("import");
  setWork("Reading from Spotify", "Playlists come from Spotify's public pages, so no login is needed.");
  setLabels("Spotify", "Reading…");
  show("working");

  const added = [];
  const fromProfiles = [];
  const problems = [];
  for (const [i, c] of collections.entries()) {
    if (state.run.cancelled) break;
    tick({ label: `Reading ${c.kind} ${i + 1} of ${collections.length}…`, done: 0, total: 0, verb: "Reading…" });
    try {
      added.push(libEntry(await readCollection(c)));
    } catch (err) {
      problems.push(err.message);
    }
  }

  for (const id of users) {
    if (state.run.cancelled) break;
    tick({ label: "Listing the playlists on that profile…", done: 0, total: 0, verb: "Reading…" });
    try {
      const prof = await api("/api/spotify/user", { method: "POST", body: { id } });
      const lists = prof.playlists.filter((p) => p.count !== 0);
      if (!lists.length) {
        problems.push(`${prof.name}'s profile doesn't show any playlists. In Spotify, open a playlist's ••• menu and choose Add to profile, or paste that playlist's link here instead.`);
      }
      fromProfiles.push(...lists.map((p) => libEntry({
        name: p.name, image: p.image, owner: p.owner, source: "profile", sid: p.id, description: p.description || "",
        pending: true, count: p.count,
      })));
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
      name: `Pasted songs ${new Date().toLocaleDateString()}`,
      source: "paste",
      tracks,
      note: missing ? `${plural(missing, "song")} couldn't be read` : null,
    }));
  }

  const cancelled = state.run.cancelled;
  endRun();
  setTape(0, false);
  resetDeck();
  // Playlists pasted by link are ticked straight away. A whole profile isn't: the user picks from it.
  const n = addToLibrary(added) + addToLibrary(fromProfiles, { select: false });
  if (n || (fromProfiles.length && !problems.length)) $("#paste-box").value = "";
  const notes = [...new Set(problems)];
  if (localFiles) notes.push(`${plural(localFiles, "local file")} skipped: local files aren't on Spotify, so they can't be matched.`);
  if (cancelled) notes.unshift("Stopped. Anything read before you stopped was added.");
  goAdd();
  if (notes.length) flash(notes.join(" "));
  else if (fromProfiles.length || n) $("#shelf-head").scrollIntoView({ block: "start", behavior: "smooth" });
});

const EXAMPLE = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M";
$("#try-example").addEventListener("click", () => {
  $("#paste-box").value = EXAMPLE;
  $("#form-paste").requestSubmit();
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
  // True when this browser signs in through a Google project the user made, not the site's shared one.
  usingOwn() { return !!store.get("google.clientId") && store.get("google.clientId") !== state.config.google_client_id; },
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
      const maybeBlocked = resp.error === "popup_closed" || resp.error === "access_denied";
      const first = resp.error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in was closed before it finished.";
      if (maybeBlocked && !this.usingOwn()) {
        flash(
          `${first} If Google said “Access blocked”, Dubdeck's Google app is still waiting for Google's review, so only people on its test list can sign in. You can sign in through your own free Google project instead. It takes about ten minutes and gives you your own daily limit too.`,
          [{ label: "Use my own Google project", run: () => showGoogleSetup() }]
        );
        return false;
      }
      const msg = maybeBlocked
        ? `${first} If Google said “Access blocked”, add the Gmail address you signed in with as a test user of your Google project (Google Auth Platform › Audience › Test users), wait a minute, then try again.`
        : resp.error === "popup_failed_to_open"
          ? "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again."
          : `Google sign-in failed: ${resp.error_description || resp.error}`;
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
    if (state.view === "review") loadYtPlaylists();
    return true;
  },

  signOut() {
    const t = store.get("google.token");
    if (t?.access_token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.access_token, () => {});
    store.del("google.token");
    store.del("google.account");
    state.ytPlaylists = null;
    ytAccountGen++;
    renderDecks();
    renderActionBar();
    if (state.view === "review") renderReview();
  },
};

// The signed-in user's own playlists, for "Send to". Costs 1 quota unit per 50 playlists.
let ytPlaylistsLoading = null;
let ytAccountGen = 0; // bumped on sign-out, so a late answer for the old account is dropped
function loadYtPlaylists() {
  if (!gauth.signedIn() || state.ytPlaylists || ytPlaylistsLoading) return ytPlaylistsLoading;
  const gen = ytAccountGen;
  ytPlaylistsLoading = yt.myPlaylists()
    .then((list) => { if (gen === ytAccountGen) { state.ytPlaylists = list; refreshTargets(); } })
    .catch(() => { if (gen === ytAccountGen) state.ytPlaylists = []; }) // a convenience only: don't retry
    .finally(() => { ytPlaylistsLoading = null; });
  return ytPlaylistsLoading;
}

// Swap in fresh "Send to" lists without redrawing the songs, so nothing the user is doing is lost.
function refreshTargets() {
  if (state.view !== "review" || !state.review) return;
  for (const sel of $$("#review-list select[id^='pl-target-']")) {
    const pl = state.review.playlists[Number(sel.id.slice("pl-target-".length))];
    if (pl && sel !== document.activeElement) sel.replaceWith(targetSelect(pl, sel.id, sel._onPick));
  }
}

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
  async myPlaylists() {
    const out = [];
    let pageToken;
    for (let page = 0; page < 10; page++) {
      const data = await ytApi("GET", "/playlists", { params: { part: "snippet,contentDetails", mine: "true", maxResults: "50", ...(pageToken ? { pageToken } : {}) } });
      for (const p of data.items || []) out.push({ id: p.id, title: p.snippet?.title || "Untitled", count: p.contentDetails?.itemCount ?? null });
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  },
  // Video ids already in a playlist: 1 quota unit per 50, against 50 units for each song added twice.
  async itemIds(playlistId) {
    const have = new Set();
    let pageToken;
    do {
      const data = await ytApi("GET", "/playlistItems", { params: { part: "contentDetails", playlistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) } });
      for (const it of data.items || []) if (it.contentDetails?.videoId) have.add(it.contentDetails.videoId);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return have;
  },
  // Which of these videos the user has already liked: 1 unit per 50.
  async liked(ids) {
    const have = new Set();
    for (let i = 0; i < ids.length; i += 50) {
      const data = await ytApi("GET", "/videos/getRating", { params: { id: ids.slice(i, i + 50).join(",") } });
      for (const r of data.items || []) if (r.rating === "like") have.add(r.videoId);
    }
    return have;
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
    <text class="c-side" x="32" y="52">${k.toUpperCase()}</text>
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
  const songs = state.library.reduce((a, p) => a + songCount(p), 0);
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
  if (view !== "review") stopPlayer();
  state.view = view;
  renderActionBar();
}

// A problem the user has to read. `actions` are buttons that fix it: [{ label, run }].
function flash(msg, actions = []) {
  $("#flash-text").textContent = msg;
  $("#flash-actions").replaceChildren(...actions.map((a) =>
    h("button", { type: "button", class: "key key-small", onclick: () => { clearFlash(); a.run(); } }, a.label)
  ));
  $("#flash").hidden = false;
  $("#flash").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function clearFlash() { $("#flash").hidden = true; }
$("#flash-close").addEventListener("click", clearFlash);

// A short note that goes away by itself, with an optional action such as Undo.
let toastTimer;
function toast(msg, action) {
  clearTimeout(toastTimer);
  $("#toast-text").textContent = msg;
  const btn = $("#toast-act");
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(); action.run(); };
  }
  $("#toast").hidden = false;
  toastTimer = setTimeout(hideToast, action ? 7000 : 3500);
}
function hideToast() { clearTimeout(toastTimer); $("#toast").hidden = true; }

function showGoogleSetup() {
  const site = state.config.google_client_id;
  const own = gauth.usingOwn();
  $("#g-origin").textContent = location.origin;
  $("#g-title").textContent = site ? "Use your own Google project" : "Set up Google sign-in";
  $("#g-lede").textContent = site
    ? "Dubdeck signs in through one shared Google project, so everyone using this site shares its daily limit of about 200 songs. Until Google finishes reviewing it, it also only lets in people on its test list. A Google project of your own is free, takes about ten minutes, and gives you your own limit."
    : "This copy of Dubdeck doesn't have a Google sign-in ID yet. Making one is free and takes about ten minutes.";
  const cur = $("#g-current");
  cur.hidden = !own;
  if (own) {
    cur.replaceChildren(
      "You're signing in through your own project (", h("code", { text: clip(store.get("google.clientId"), 28) }), "). ",
      site ? h("button", { type: "button", class: "textbtn", onclick: () => switchClientId(null) }, "Go back to Dubdeck's") : null
    );
  }
  $("#google-client-id").value = own ? store.get("google.clientId") : "";
  $("#google-setup").hidden = false;
  $("#google-setup").scrollIntoView({ block: "start", behavior: "smooth" });
}

function switchClientId(id) {
  if (gauth.signedIn()) gauth.signOut(); // a token belongs to the project that issued it
  if (id) store.set("google.clientId", id);
  else store.del("google.clientId");
  $("#google-setup").hidden = true;
  clearFlash();
  if (id) gauth.signIn();
  else toast("Back to Dubdeck's Google project.");
}

$("#copy-origin").addEventListener("click", (e) => copyText(location.origin, e.currentTarget));
$("#g-close").addEventListener("click", () => ($("#google-setup").hidden = true));
$("#own-project").addEventListener("click", () => showGoogleSetup());
$("#form-google").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#google-client-id").value.trim();
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) {
    flash("That doesn't look like a Google client ID. It ends in .apps.googleusercontent.com.");
    return;
  }
  switchClientId(id);
});

// Colours: Auto follows the system; Light and Dark stick.
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
$$("#theme-switch input").forEach((r) => {
  r.checked = r.value === (store.get("theme") || "auto");
  r.addEventListener("change", () => {
    store.set("theme", r.value);
    applyTheme(r.value);
  });
});

function renderActionBar() {
  const bar = $("#actionbar"), btn = $("#action-btn"), sum = $("#action-summary");
  btn.replaceChildren();
  btn.disabled = false;
  if (state.view === "add") {
    const chosen = state.library.filter((p) => state.selected.has(p.uid));
    const songs = chosen.reduce((a, p) => a + songCount(p), 0);
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

// The player and toasts float just above the sticky action bar, whatever its height.
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--bar-h", `${$("#actionbar").offsetHeight}px`);
}).observe($("#actionbar"));

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

const SOURCE_TEXT = { paste: "pasted", playlist: "from a playlist link", profile: "from a profile", album: "album", file: "from a file", export: "from Spotify's data download" };

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
  const meta = [p.pending && p.count == null ? null : plural(songCount(p), "song"), p.owner && p.source !== "paste" ? `by ${p.owner}` : null, SOURCE_TEXT[p.source]].filter(Boolean).join(", ");
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
      onclick: () => removeFromShelf((x) => x.uid === p.uid, `Removed “${clip(p.name, 40)}”.`),
    }, "Remove")
  );
}

// Removing is instant; the toast offers Undo for a few seconds.
function removeFromShelf(match, message) {
  const before = { library: state.library, selected: new Set(state.selected) };
  state.library = state.library.filter((x) => !match(x));
  state.library.length === 0 ? state.selected.clear() : before.library.filter(match).forEach((x) => state.selected.delete(x.uid));
  saveLibrary();
  renderShelf();
  toast(message, {
    label: "Undo",
    run: () => { state.library = before.library; state.selected = before.selected; saveLibrary(); renderShelf(); },
  });
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
$("#pl-clear").addEventListener("click", () => {
  const n = state.library.length;
  removeFromShelf(() => true, `Removed ${plural(n, "playlist")}.`);
});

// ------------------------------------------------------------------ running work

function setWork(title, lede) {
  $("#work-title").textContent = title;
  $("#work-lede").textContent = lede;
  $("#work-label").textContent = "Starting…";
  $("#work-eta").textContent = "";
  $("#work-bar i").style.width = "0%";
}

const BASE_TITLE = "Dubdeck";
const RUN_TITLE = { import: "Reading", match: "Matching", transfer: "Transferring" };

function tick({ label, done, total, verb }) {
  const p = total ? done / total : 0;
  setCounter(done);
  setTape(p, true);
  setTransport(total ? `${done.toLocaleString()} of ${total.toLocaleString()}` : verb || "Working…");
  if (label) $("#work-label").textContent = label;
  $("#work-bar i").style.width = `${Math.round(p * 100)}%`;
  $("#work-bar").setAttribute("aria-valuenow", Math.round(p * 100));
  const r = state.run;
  if (!r) return;
  document.title = total ? `${Math.round(p * 100)}% ${RUN_TITLE[r.kind]} · ${BASE_TITLE}` : `${RUN_TITLE[r.kind]} · ${BASE_TITLE}`;
  // Time left, from the pace so far. Transfers stop at Google's daily limit, so they get none.
  let eta = "";
  if (total && r.kind !== "transfer") {
    if (r.d0 == null || done < r.d0) { r.d0 = done; r.t0 = performance.now(); }
    const secs = (performance.now() - r.t0) / 1000, n = done - r.d0;
    if (secs > 4 && n >= 3 && done < total) eta = etaText(((total - done) * secs) / n);
  }
  $("#work-eta").textContent = eta;
}

$("#work-stop").addEventListener("click", (e) => {
  if (!state.run) return;
  state.run.cancelled = true;
  e.currentTarget.disabled = true;
  e.currentTarget.textContent = "Stopping…";
});

// Keeps the screen on while something long runs, so a laptop doesn't sleep halfway through.
const wake = {
  lock: null,
  wanted: false,
  async on() {
    this.wanted = true;
    try {
      const lock = await navigator.wakeLock?.request("screen");
      if (this.wanted) this.lock = lock;
      else lock?.release().catch(() => {}); // the run ended while the browser was deciding
    } catch { this.lock = null; }
  },
  off() { this.wanted = false; this.lock?.release?.().catch(() => {}); this.lock = null; },
};
document.addEventListener("visibilitychange", () => {
  if (state.run && document.visibilityState === "visible" && (!wake.lock || wake.lock.released)) wake.on();
});

function beginRun(kind) {
  state.run = { kind, cancelled: false, t0: performance.now(), d0: null };
  const b = $("#work-stop");
  b.disabled = false;
  b.textContent = "Stop";
  stopPlayer();
  wake.on();
}

// `note` shows in the tab title while the tab is in the background, so a finished run is easy to spot.
function endRun(note) {
  state.run = null;
  wake.off();
  document.title = BASE_TITLE;
  if (note && document.hidden) {
    document.title = `${note} · ${BASE_TITLE}`;
    const back = () => { if (!document.hidden) { document.title = BASE_TITLE; document.removeEventListener("visibilitychange", back); } };
    document.addEventListener("visibilitychange", back);
  }
}

window.addEventListener("beforeunload", (e) => {
  if (state.run) { e.preventDefault(); e.returnValue = ""; }
});

// ------------------------------------------------------------------ matching

const trackKey = (t) => t.id || `${t.title}|${t.artists.join(",")}`;

async function startMatch() {
  clearFlash();
  let pls = state.library.filter((p) => state.selected.has(p.uid));
  if (!pls.length) return;
  beginRun("match");

  // Playlists listed from a profile don't have their songs yet: read those first.
  const unread = pls.filter((p) => p.pending);
  const problems = [];
  if (unread.length) {
    setWork("Reading your playlists from Spotify", "Playlists come from Spotify's public pages, so no login is needed.");
    setLabels("Spotify", "Reading…");
    show("working");
    for (const [i, p] of unread.entries()) {
      if (state.run.cancelled) break;
      tick({ label: `Reading “${p.name}”…`, done: i, total: unread.length });
      try {
        const got = await readCollection({ kind: "playlist", id: p.sid });
        Object.assign(p, { tracks: got.tracks, note: got.note, description: got.description || p.description, image: p.image || got.image, pending: false });
        if (!got.tracks.length) problems.push(`“${p.name}” has no songs Dubdeck can read.`);
      } catch (err) {
        problems.push(`“${p.name}”: ${err.message}`);
      }
    }
    saveLibrary();
    pls = pls.filter((p) => !p.pending && p.tracks.length);
    if (state.run.cancelled || !pls.length) {
      const stopped = state.run.cancelled;
      endRun();
      resetDeck();
      goAdd();
      if (stopped) problems.unshift("Stopped.");
      if (problems.length) flash(problems.join(" "));
      return;
    }
  }

  setWork("Finding your songs on YouTube Music", "Each song is matched by title, artist and length, and by its recording code when Spotify shares one. Keep this tab open.");
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
          results = (await api("/api/ytm/match", { method: "POST", body: { tracks: batch.map((b) => trackBody(b.t)), region } })).results;
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
  endRun(cancelled ? null : "Matches ready");

  const playlists = pls.map((p, pi) => ({
    name: p.name, description: p.description, image: p.image, liked: p.liked, sid: p.sid, src: p.uid, source: p.source,
    tracks: p.tracks.map((t, ti) => rows[pi][ti] || { spotify: t, match: null, candidates: [], error: "Stopped before this song was matched." }),
  }));
  setTape(1, false);
  setTransport(cancelled ? "Stopped" : "Matched");
  setLabels("Spotify", "YouTube Music");
  loadReview(playlists);
  show("review");
  if (problems.length) flash(problems.join(" "));
}

// ------------------------------------------------------------------ review

// `t.ok` means the user has looked at this song and decided, so it no longer needs checking.
function category(t) {
  if (!t.pick) return "missing";
  if (t.ok || t.pick.confidence === "high" || t.pick.confidence === "manual") return "ok";
  return "review";
}
const needsCheck = (t) => !t.ok && category(t) !== "ok";

const songText = (t) => [t.spotify.title, ...t.spotify.artists, t.spotify.album, t.pick?.title, t.pick?.artists].filter(Boolean).join(" ").toLowerCase();

function inFilter(t) {
  if (state.songQuery && !state.songQuery.split(/\s+/).every((w) => songText(t).includes(w))) return false;
  switch (state.filter) {
    case "review": return category(t) === "review";
    case "missing": return category(t) === "missing";
    case "skipped": return !!t.pick && !t.sel;
    default: return true;
  }
}

// A fresh match keeps what the user already decided: per playlist (name, visibility, where it goes)
// and per song (the chosen version, ticked or not). Going back to add one more playlist loses nothing.
function loadReview(playlists) {
  const many = playlists.length > 1;
  const before = state.review?.playlists || [];
  const plPrev = new Map(before.filter((pl) => pl.src).map((pl) => [pl.src, pl]));
  const songPrev = new Map();
  for (const pl of before) for (const t of pl.tracks) if (!t.error) songPrev.set(trackKey(t.spotify), t);

  state.review = {
    playlists: playlists.map((pl) => {
      const old = plPrev.get(pl.src);
      const sent = sentTo.get(pl);
      return {
        ...pl,
        outName: old?.outName ?? (pl.liked ? "Liked Songs from Spotify" : pl.name),
        privacy: old?.privacy ?? "PRIVATE",
        mode: old?.mode ?? "playlist",
        target: old ? old.target ?? null : sent && pl.source !== "paste" ? { id: sent.playlistId, title: sent.title } : null,
        collapsed: old?.collapsed ?? (many && pl.tracks.length > 60),
        tracks: pl.tracks.map((t) => {
          const prev = !t.error && songPrev.get(trackKey(t.spotify));
          if (prev && (prev.ok || prev.pick)) return { ...t, candidates: prev.candidates, pick: prev.pick, sel: prev.sel, ok: prev.ok };
          return { ...t, pick: t.match, sel: !!t.match && t.match.confidence !== "low" };
        }),
      };
    }),
  };
  state.transfer = null;
  store.del("transfer");
  state.filter = "all";
  state.songQuery = "";
  $("#song-filter").value = "";
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
  renderCheckstrip();
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
  const cards = state.review.playlists
    .map((pl, pi) => (state.songQuery && !pl.tracks.some(inFilter) ? null : jcard(pl, pi)))
    .filter(Boolean);
  $("#review-list").replaceChildren(...(cards.length ? cards : [h("p", { class: "panel empty-search", text: `No songs match “${state.songQuery}”.` })]));
  renderActionBar();
  if (gauth.signedIn() && !state.ytPlaylists) loadYtPlaylists();
}

// The strip above the list: how many songs still need a decision, and ways to make them.
function renderCheckstrip() {
  const todo = state.review.playlists.flatMap((pl) => pl.tracks).filter(needsCheck);
  const review = todo.filter((t) => category(t) === "review").length;
  const missing = todo.length - review;
  $("#checkstrip").hidden = !todo.length;
  if (!todo.length) return;
  const parts = [review ? `${plural(review, "match", "matches")} to check` : null, missing ? `${plural(missing, "song")} not found` : null];
  $("#checkstrip-text").replaceChildren(
    h("strong", { text: parts.filter(Boolean).join(" and ") }), ". ",
    review
      ? todo.length === 1 ? "Have a listen, or decide from here." : "Go through them one at a time with the keyboard, or decide for all the uncertain ones at once."
      : todo.length === 1 ? "Search for it, or leave it out." : "Go through them to search for each one, or leave them out."
  );
  $("#keep-all").hidden = $("#drop-all").hidden = !review;
  $("#keep-all").textContent = review === 1 ? "Keep it" : `Keep all ${review.toLocaleString()}`;
  $("#drop-all").textContent = review === 1 ? "Leave it out" : `Leave all ${review.toLocaleString()} out`;
  $("#check-start").textContent = todo.length === 1 ? "Check it" : "Check them one by one";
}

function decideAll(keep) {
  const hit = state.review.playlists.flatMap((pl) => pl.tracks).filter((t) => needsCheck(t) && category(t) === "review");
  const undo = hit.map((t) => [t, t.sel, t.ok]);
  hit.forEach((t) => { t.sel = keep; t.ok = true; });
  saveReview();
  renderReview();
  toast(`${keep ? "Kept" : "Left out"} ${plural(hit.length, "song")}.`, {
    label: "Undo",
    run: () => { undo.forEach(([t, sel, ok]) => { t.sel = sel; t.ok = ok; }); saveReview(); renderReview(); },
  });
}
$("#keep-all").addEventListener("click", () => decideAll(true));
$("#drop-all").addEventListener("click", () => decideAll(false));
$("#check-start").addEventListener("click", () => openCheck());

$("#song-filter").addEventListener("input", debounce((e) => {
  state.songQuery = e.target.value.trim().toLowerCase();
  state.shown = {};
  state.openAlt = null;
  renderReview();
}, 150));

function matchesCsv() {
  const rows = [["Playlist", "Position", "Spotify title", "Spotify artists", "Spotify album", "Spotify link",
    "YouTube Music title", "YouTube Music artists", "YouTube Music link", "Match", "Included"]];
  for (const pl of state.review.playlists) {
    pl.tracks.forEach((t, ti) => {
      const sp = t.spotify, c = t.pick;
      const match = !c ? "not found" : c.confidence === "manual" ? "your link" : t.ok ? `${c.confidence}, checked by you` : c.confidence;
      rows.push([pl.name, ti + 1, sp.title, sp.artists.join(", "), sp.album, sp.id ? `https://open.spotify.com/track/${sp.id}` : "",
        c?.title, c?.artists, c ? `https://music.youtube.com/watch?v=${c.videoId}` : "", match, c && t.sel ? "yes" : "no"]);
    });
  }
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
const downloadMatches = () => downloadFile(`dubdeck-${new Date().toLocaleDateString("sv")}.csv`, matchesCsv(), "text/csv;charset=utf-8");
$("#download-csv").addEventListener("click", downloadMatches);

function statsLine(pl) {
  const c = counts(pl.tracks);
  return [
    h("span", {}, h("span", { class: "led on", "aria-hidden": "true" }), `${c.selected.toLocaleString()} of ${plural(c.all, "song")} selected`),
    c.review ? h("span", {}, h("span", { class: "led amber", "aria-hidden": "true" }), `${c.review} to check`) : null,
    c.missing ? h("span", {}, h("span", { class: "led rec", "aria-hidden": "true" }), `${c.missing} not found`) : null,
  ].filter(Boolean);
}

// "Send to": a new playlist, the one this playlist went to last time, or any of the user's playlists.
function targetSelect(pl, id, onPick) {
  const sent = sentTo.get(pl);
  const mine = (state.ytPlaylists || []).filter((p) => p.id !== sent?.playlistId);
  const options = [h("option", { value: "", selected: !pl.target }, "A new playlist")];
  if (sent) options.push(h("option", { value: sent.playlistId, selected: pl.target?.id === sent.playlistId }, `${clip(sent.title, 34)} (sent ${fmtDay(sent.at)})`));
  if (mine.length) {
    options.push(h("optgroup", { label: "Your YouTube playlists" },
      ...mine.map((p) => h("option", { value: p.id, selected: pl.target?.id === p.id }, `${clip(p.title, 40)}${p.count != null ? ` (${p.count})` : ""}`))));
  }
  if (pl.target && pl.target.id !== sent?.playlistId && !mine.some((p) => p.id === pl.target.id)) {
    options.push(h("option", { value: pl.target.id, selected: true }, clip(pl.target.title, 40)));
  }
  if (!gauth.signedIn()) options.push(h("option", { value: "__signin" }, "One of my playlists (sign in)…"));
  const select = h("select", {
    id,
    onchange: async (e) => {
      const v = e.target.value;
      if (v === "__signin") {
        e.target.value = pl.target?.id || "";
        if (await gauth.signIn()) await loadYtPlaylists();
        return;
      }
      const title = v === sent?.playlistId ? sent.title : (state.ytPlaylists || []).find((p) => p.id === v)?.title || pl.target?.title || "";
      onPick(v ? { id: v, title } : null);
    },
  }, ...options);
  select._onPick = onPick; // refreshTargets() rebuilds the list with the same callback
  return select;
}

function jcard(pl, pi) {
  const nameId = `pl-name-${pi}`, privId = `pl-priv-${pi}`, modeId = `pl-mode-${pi}`, targetId = `pl-target-${pi}`;
  const stats = h("div", { class: "jcard-stats" }, statsLine(pl));
  const like = pl.mode === "like";
  const existing = !like && !!pl.target;
  const redraw = () => {
    const focused = card.contains(document.activeElement) ? document.activeElement.id : null;
    saveReview();
    card.replaceWith(jcard(pl, pi));
    if (focused) document.getElementById(focused)?.focus(); // keep the keyboard on the select just changed
  };

  const opts = h("div", { class: "jcard-opts" });
  if (pl.liked) {
    const mode = h("select", { id: modeId, onchange: (e) => { pl.mode = e.target.value; redraw(); } },
      h("option", { value: "playlist", selected: !like }, "Make a playlist"),
      h("option", { value: "like", selected: like }, "Like each song")
    );
    opts.append(h("div", { class: "field" }, h("label", { for: modeId, text: "On YouTube Music" }), mode));
  }
  if (!like) {
    opts.append(h("div", { class: "field field-target" }, h("label", { for: targetId, text: "Send to" }),
      targetSelect(pl, targetId, (target) => { pl.target = target; redraw(); })));
  }
  if (!like && !existing) {
    const privacy = h("select", { id: privId, onchange: (e) => { pl.privacy = e.target.value; saveReview(); } },
      ...[["PRIVATE", "Private"], ["UNLISTED", "Unlisted"], ["PUBLIC", "Public"]].map(([v, l]) => h("option", { value: v, selected: pl.privacy === v }, l))
    );
    opts.append(h("div", { class: "field" }, h("label", { for: privId, text: "Visibility" }), privacy));
  }
  opts.append(h("button", {
    type: "button", class: "key key-small", "aria-expanded": String(!pl.collapsed),
    onclick: () => { pl.collapsed = !pl.collapsed; redraw(); },
  }, pl.collapsed ? "Show songs" : "Hide songs"));

  const nameInput = h("input", {
    type: "text", id: nameId, value: existing ? pl.target.title : pl.outName, maxlength: "150", disabled: like || existing,
    oninput: (e) => { pl.outName = e.target.value; saveReview(); },
  });
  const label = like
    ? `Liked one by one (from “${pl.name}”)`
    : existing ? `Adding new songs to this playlist (from “${pl.name}”). Songs already in it are skipped.` : `New playlist name (from “${pl.name}”)`;

  const head = h("header", { class: "jcard-head" },
    coverFor(pl),
    h("div", { class: "jcard-title" }, h("label", { class: "label", for: nameId, text: label }), nameInput, stats),
    opts
  );
  const card = h("section", { class: "jcard", "aria-label": pl.name }, head);
  if (!pl.collapsed || state.songQuery) card.append(trackList(pl, pi, stats));
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

// A triangle, or three bouncing bars while that song is playing.
const playIcon = () => h("span", { class: "play-ico", "aria-hidden": "true" }, h("i"), h("i"), h("i"));

function playYtButton(c, cls = "thumb thumb-play") {
  const key = `yt:${c.videoId}`;
  return h("button", {
    type: "button", class: cls, "data-play": key, "aria-pressed": String(isPlaying(key)),
    "aria-label": `Listen to ${c.title} on YouTube Music`, title: "Listen",
    onclick: () => play("yt", c.videoId, c.title, c.artists),
  }, c.thumbnail ? h("img", { src: c.thumbnail, alt: "", loading: "lazy", onerror: (e) => e.target.remove() }) : null, playIcon());
}

function trackRow(pl, pi, t, ti, stats) {
  const sp = t.spotify, c = t.pick;
  const key = `${pi}:${ti}`;
  const spUrl = sp.id ? `https://open.spotify.com/track/${sp.id}` : null;
  const numText = String(ti + 1).padStart(2, "0");
  const num = sp.id
    ? h("button", {
        type: "button", class: "num num-play", "data-play": `sp:${sp.id}`, "aria-pressed": String(isPlaying(`sp:${sp.id}`)),
        "aria-label": `Listen to ${sp.title} on Spotify`, title: "Listen on Spotify",
        onclick: () => play("sp", sp.id, sp.title, sp.artists.join(", ")),
      }, h("span", { class: "n", text: numText }), playIcon())
    : h("span", { class: "num", text: numText });
  const sideA = h("div", { class: "side side-a" },
    spUrl ? h("a", { class: "t-title", href: spUrl, target: "_blank", rel: "noopener", text: sp.title }) : h("span", { class: "t-title", text: sp.title }),
    h("span", { class: "t-sub", text: sp.artists.join(", ") })
  );
  const sideB = c
    ? h("div", { class: "side side-b" },
        playYtButton(c),
        h("div", {},
          h("a", { class: "t-title", href: `https://music.youtube.com/watch?v=${c.videoId}`, target: "_blank", rel: "noopener", text: c.title }),
          h("span", { class: "t-sub" }, c.artists || (c.type === "video" ? "Video" : ""), c.album ? h("span", { class: "album", text: c.album }) : null)
        )
      )
    : h("p", { class: "missing-note", text: t.error ? `Search failed: ${t.error}` : "No match found. Use Change to search or paste a link." });

  const li = h("li", { class: `track${t.sel && c ? "" : " off"}${t.ok && c && t.pick.confidence !== "high" ? " checked" : ""}` },
    h("input", {
      type: "checkbox", checked: t.sel && !!c, disabled: !c, "aria-label": `Include ${sp.title}`,
      onchange: (e) => { t.sel = e.target.checked; t.ok = true; refreshRow(); },
    }),
    num,
    sideA,
    meter(c),
    sideB,
    durCell(t, c),
    h("button", {
      type: "button", class: "key key-small key-ghost", "aria-expanded": String(state.openAlt === key),
      onclick: () => { state.openAlt = state.openAlt === key ? null : key; refreshRow(state.openAlt === key ? ".chooser input:checked" : null); },
    }, state.openAlt === key ? "Close" : "Change")
  );

  // `focus` is a selector inside the reopened chooser to put the keyboard back on.
  function refreshRow(focus = null) {
    saveReview();
    const next = li.nextElementSibling;
    if (next && next.classList.contains("alts")) next.remove();
    const fresh = trackRow(pl, pi, t, ti, stats);
    li.replaceWith(fresh);
    if (state.openAlt === key) {
      const alt = altsRow(pl, pi, t, ti);
      fresh.after(alt);
      if (focus) alt.querySelector(focus)?.focus();
    }
    stats.replaceChildren(...statsLine(pl));
    renderFilterCounts();
    renderActionBar();
  }
  li._refresh = refreshRow;
  return li;
}

function altsRow(pl, pi, t, ti) {
  const box = h("li", { class: "alts" });
  box.append(chooser(t, { name: `alt-${pi}-${ti}`, onChange: (focus) => box.previousElementSibling?._refresh?.(focus) }));
  return box;
}

const trackBody = (sp) => ({
  id: sp.id || null, title: String(sp.title).slice(0, 500), artists: (sp.artists || []).slice(0, 30),
  album: String(sp.album || "").slice(0, 500), duration_sec: sp.duration_sec || null, isrc: sp.isrc ? String(sp.isrc).slice(0, 20) : null,
});

// "Song (feat. X) [From Y] - Remastered 2011" searches better as "Song".
const searchTitle = (s) => s.replace(/\s*[([][^)\]]*[)\]]/g, "").replace(/\s+[-–—]\s+.*$/, "").trim() || s;

const mergeCands = (first, rest) => {
  const seen = new Set();
  return [...first, ...(rest || [])].filter((c) => c && !seen.has(c.videoId) && seen.add(c.videoId)).slice(0, 12);
};

// The versions to pick from, "Leave this song out", and a box that searches YouTube Music or takes a
// link. Used under a song in the list and in Check one by one. `onChange(focus)` redraws it.
function chooser(t, { name, onChange, keys = false }) {
  const chosen = t.sel && t.pick ? t.pick.videoId : null;
  const cands = [...(t.candidates || [])];
  if (t.pick && !cands.some((c) => c.videoId === t.pick.videoId)) cands.unshift(t.pick);

  const choose = (cand) => {
    if (cand) { t.pick = cand; t.sel = true; } else t.sel = false;
    t.ok = true;
    onChange(".alt input:checked");
  };

  const options = cands.map((c, i) =>
    h("label", { class: "alt", for: `${name}-${i}` },
      h("input", { type: "radio", name, id: `${name}-${i}`, checked: chosen === c.videoId, onchange: () => choose(c) }),
      keys ? h("kbd", { class: "alt-key", "aria-hidden": "true", text: i < 9 ? String(i + 1) : "" }) : null,
      playYtButton(c),
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
      h("input", { type: "radio", name, id: `${name}-none`, checked: !chosen, onchange: () => choose(null) }),
      keys ? h("kbd", { class: "alt-key", "aria-hidden": "true", text: "X" }) : null,
      h("span", { class: "t-sub", text: "Leave this song out" })
    )
  );

  const qId = `${name}-q`;
  const fallback = [searchTitle(t.spotify.title), t.spotify.artists[0]].filter(Boolean).join(" ");
  const input = h("input", { type: "search", id: qId, class: "chooser-q", placeholder: fallback, maxlength: "200", autocomplete: "off", spellcheck: "false", enterkeyhint: "search" });
  const btn = h("button", { class: "key key-small", type: "submit" }, "Search");
  const status = h("p", { class: "chooser-status", role: "status" });
  const form = h("form", { class: "inline-form chooser-search", autocomplete: "off" },
    h("div", { class: "field" }, h("label", { for: qId, text: "Search YouTube Music, or paste a YouTube link" }), input),
    btn
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim() || fallback;
    const isLink = /^(https?:\/\/|www\.|(m\.|music\.)?youtube\.com\/|youtu\.be\/)/i.test(q);
    btn.disabled = true;
    btn.textContent = isLink ? "Looking up…" : "Searching…";
    status.textContent = "";
    try {
      if (isLink) {
        const { candidate } = await api("/api/ytm/lookup", { method: "POST", body: { url: q } });
        t.candidates = mergeCands([candidate], t.candidates);
        // If the user moved on meanwhile, keep the result for that song but don't decide it or steal focus.
        if (form.isConnected) choose(candidate);
        else saveReview();
        return;
      }
      const { candidates } = await api("/api/ytm/search", { method: "POST", body: { query: q, track: trackBody(t.spotify), region } });
      if (!candidates.length) throw new Error(`Nothing on YouTube Music for “${q}”. Try fewer words.`);
      t.candidates = mergeCands(candidates, t.candidates);
      saveReview();
      if (form.isConnected) onChange(".alt input");
    } catch (err) {
      status.textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Search";
    }
  });

  return h("div", { class: "chooser" },
    h("fieldset", { class: "alts-list" }, h("legend", { class: "sr-only", text: `Versions of ${t.spotify.title}` }), ...options),
    form,
    status
  );
}

// ------------------------------------------------------------------ check one by one

const check = { queue: [], i: 0 };

function openCheck() {
  const queue = [];
  state.review.playlists.forEach((pl, pi) => pl.tracks.forEach((t, ti) => needsCheck(t) && queue.push([pi, ti])));
  if (!queue.length) return toast("Nothing left to check.");
  check.queue = queue;
  check.i = 0;
  stopPlayer();
  if (!$("#check").open) $("#check").showModal();
  renderCheck();
}

function checkItem() {
  const at = check.queue[check.i];
  if (!at) return null;
  const pl = state.review.playlists[at[0]];
  return { pl, ti: at[1], t: pl.tracks[at[1]] };
}

function renderCheck(focus) {
  const n = check.queue.length, it = checkItem();
  $("#check-count").textContent = `${Math.min(check.i + 1, n)} of ${n}`;
  $("#check-bar i").style.width = `${Math.round((check.i / n) * 100)}%`;
  $("#check-foot").hidden = $("#check-keys").hidden = !it;
  const body = $("#check-body");

  if (!it) {
    const left = check.queue.filter(([pi, ti]) => needsCheck(state.review.playlists[pi].tracks[ti])).length;
    body.replaceChildren(h("div", { class: "check-end" },
      h("p", { class: "check-song", text: left ? `${plural(left, "song")} skipped for now` : "All checked" }),
      h("p", { class: "lede", text: left ? `${left === 1 ? "It's" : "They're"} still marked to check in the list.` : "Every song here has a decision. Transfer is at the bottom of the page when you're ready." }),
      h("div", { class: "check-end-keys" },
        left ? h("button", { type: "button", class: "key", onclick: () => openCheck() }, "Go through the skipped ones") : null,
        h("button", { type: "button", class: "key key-primary", onclick: () => $("#check").close() }, "Back to the list")
      )
    ));
    body.querySelector(".key-primary").focus();
    return;
  }

  const { pl, ti, t } = it;
  const sp = t.spotify;
  const listenA = sp.id
    ? h("button", {
        type: "button", class: "key key-small listen", "data-play": `sp:${sp.id}`, "aria-pressed": String(isPlaying(`sp:${sp.id}`)),
        onclick: () => play("sp", sp.id, sp.title, sp.artists.join(", ")),
      }, playIcon(), "Listen")
    : null;
  const note = t.error
    ? `The search failed (${t.error}). Try searching below.`
    : !t.pick && !t.candidates?.length ? "Nothing close turned up. Search with other words, paste a link, or leave it out." : null;

  body.replaceChildren(
    h("section", { class: "check-side check-a", "aria-label": "Side A: the Spotify song" },
      h("p", { class: "side-tag" }, h("b", { text: "A" }), `Spotify, “${clip(pl.name, 40)}” no. ${ti + 1}`),
      h("div", { class: "check-a-row" },
        h("div", { class: "check-a-text" },
          h("p", { class: "check-song", text: sp.title }),
          h("p", { class: "t-sub", text: [sp.artists.join(", "), sp.album, fmtTime(sp.duration_sec)].filter(Boolean).join(" · ") })
        ),
        listenA
      )
    ),
    h("section", { class: "check-side check-b", "aria-label": "Side B: pick the YouTube Music version" },
      h("p", { class: "side-tag" }, h("b", { text: "B" }), "YouTube Music: pick the same recording"),
      note ? h("p", { class: "missing-note", text: note }) : null,
      chooser(t, { name: "chk", keys: true, onChange: (f) => { saveReview(); renderCheck(f); } })
    )
  );
  $("#check-keep").textContent = t.sel && t.pick ? "Keep this match" : "Leave it out";
  $("#check-prev").disabled = check.i === 0;
  renderPlayer();
  ((focus && body.querySelector(focus)) || $("#check-keep")).focus();
}

function checkMove(d) {
  stopPlayer();
  check.i = Math.max(0, Math.min(check.queue.length, check.i + d));
  renderCheck();
}
function checkDecide(keep) {
  const it = checkItem();
  if (!it) return;
  if (!keep) it.t.sel = false;
  it.t.ok = true;
  saveReview();
  checkMove(1);
}
function checkListen(side) {
  const it = checkItem();
  if (!it) return;
  const { t } = it, sp = t.spotify;
  if (side === "a" && sp.id) play("sp", sp.id, sp.title, sp.artists.join(", "));
  if (side === "b" && t.pick) play("yt", t.pick.videoId, t.pick.title, t.pick.artists);
}

$("#check-prev").addEventListener("click", () => checkMove(-1));
$("#check-skip").addEventListener("click", () => checkMove(1));
$("#check-keep").addEventListener("click", () => checkDecide(true));
$("#check-close").addEventListener("click", () => $("#check").close());
$("#check").addEventListener("close", () => { stopPlayer(); renderReview(); });
$("#check").addEventListener("keydown", (e) => {
  if (!checkItem() || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target, tag = el.tagName;
  if ((tag === "INPUT" && el.type !== "radio" && el.type !== "checkbox") || tag === "TEXTAREA" || tag === "SELECT") return;
  const k = e.key;
  // A held key decides one song, not the whole queue.
  if (e.repeat && k !== "ArrowLeft" && k !== "ArrowRight") {
    if (k === "Enter") e.preventDefault(); // otherwise a held Enter keeps pressing the focused button
    return;
  }
  if (k === "Enter" && (tag === "BUTTON" || tag === "A")) return; // the focused button does its own thing
  if (k === "Enter") checkDecide(true);
  else if (k === "ArrowRight") checkMove(1);
  else if (k === "ArrowLeft") checkMove(-1);
  else if (k === "x" || k === "X" || k === "0") checkDecide(false);
  else if (/^[1-9]$/.test(k)) $$("#check-body .alt:not(.none) input")[Number(k) - 1]?.click();
  else if (k === "a" || k === "A") checkListen("a");
  else if (k === "b" || k === "B") checkListen("b");
  else if (k === "/") $("#check-body .chooser-q")?.focus();
  else return;
  e.preventDefault();
});

// ------------------------------------------------------------------ player (A: Spotify, B: YouTube Music)

const player = { src: null };
const isPlaying = (key) => player.src?.key === key;

function play(kind, id, title, sub) {
  const key = `${kind}:${id}`;
  if (isPlaying(key)) return stopPlayer();
  player.src = { kind, id, key, title, sub };
  renderPlayer();
}
function stopPlayer() {
  if (!player.src) return;
  player.src = null;
  renderPlayer();
}

// One player at a time: docked at the bottom, or inside Check one by one while that's open.
function renderPlayer() {
  const inCheck = $("#check").open;
  const host = inCheck ? $("#check-player") : $("#monitor");
  const other = inCheck ? $("#monitor") : $("#check-player");
  const s = player.src;
  other.replaceChildren();
  other.dataset.key = "";
  if (!s) host.replaceChildren();
  else if (host.dataset.key !== s.key) host.replaceChildren(playerView(s));
  host.dataset.key = s?.key || "";
  $("#monitor").hidden = inCheck || !s;
  $$("[data-play]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.play === s?.key)));
}

function playerView(s) {
  const yt = s.kind === "yt";
  const src = yt
    ? `https://www.youtube-nocookie.com/embed/${s.id}?autoplay=1&rel=0&playsinline=1`
    : `https://open.spotify.com/embed/track/${s.id}?utm_source=dubdeck`;
  const href = yt ? `https://music.youtube.com/watch?v=${s.id}` : `https://open.spotify.com/track/${s.id}`;
  return h("div", { class: `player player-${s.kind}` },
    h("div", { class: "player-head" },
      h("span", { class: "player-side", "aria-hidden": "true", text: yt ? "B" : "A" }),
      h("p", { class: "player-title" }, h("b", { text: s.title }), s.sub ? h("span", { text: ` · ${s.sub}` }) : null),
      h("a", { class: "textbtn", href, target: "_blank", rel: "noopener" }, yt ? "Open in YouTube Music" : "Open in Spotify"),
      h("button", { type: "button", class: "textbtn", onclick: stopPlayer }, "Stop")
    ),
    h("iframe", {
      src, title: `${yt ? "YouTube" : "Spotify"} player: ${s.title}`,
      allow: "autoplay; encrypted-media; clipboard-write; fullscreen; picture-in-picture",
      referrerpolicy: "strict-origin-when-cross-origin",
    })
  );
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
    const like = pl.mode === "like";
    const target = like ? null : pl.target;
    items.push({
      pi,
      key: sentTo.key(pl),
      name: target ? target.title : (pl.outName || pl.name).trim() || pl.name,
      description: [pl.description, "Copied from Spotify with Dubdeck."].filter(Boolean).join("\n\n"),
      privacy: pl.privacy,
      mode: pl.mode,
      ids,
      dupes: all.length - ids.length,
      playlistId: target?.id || null,
      existing: !!target,
      // Before adding to an existing playlist or liking, look at what's already there (cheap) so
      // nothing is added twice (expensive). A new playlist has nothing to look at.
      synced: !like && !target,
      already: 0,
      url: like ? LIKED_URL : target ? playlistUrl(target.id) : null,
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

const LIKED_URL = "https://music.youtube.com/playlist?list=LM";
const playlistUrl = (id) => `https://music.youtube.com/playlist?list=${id}`;
const SKIPPABLE = new Set(["videoNotFound", "forbidden", "videoNotAvailable", "videoChartNotFound", "invalidVideoId", "videoRatingDisabled", "notFound"]);

// What an error means for the whole transfer. Everything here stops it; most can be continued.
function halt(T, e) {
  if (e.reason === "quotaExceeded" || e.reason === "dailyLimitExceeded") Object.assign(T, { status: "paused", reason: "quota" });
  else if (e.status === 401) Object.assign(T, { status: "paused", reason: "auth" });
  else if (e.status === 0 || e.status >= 500 || TRANSIENT.has(e.reason)) Object.assign(T, { status: "paused", reason: "network" });
  else Object.assign(T, { status: "error", message: friendlyYtError(e) });
}

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

  const total = () => T.items.reduce((a, it) => a + it.ids.length, 0);
  const done = () => T.items.reduce((a, it) => a + it.next, 0);
  const progress = (label) => tick({ label, done: done(), total: total() });

  outer: for (const it of T.items) {
    if (it.synced === false && it.ids.length) {
      if (state.run.cancelled) { T.status = "stopped"; break; }
      progress(it.mode === "like" ? "Checking which songs you've already liked…" : `Checking what's already in “${it.name}”…`);
      try {
        const have = it.mode === "like" ? await withRetry(() => yt.liked(it.ids)) : await withRetry(() => yt.itemIds(it.playlistId));
        const before = it.ids.length;
        it.ids = it.ids.filter((id) => !have.has(id));
        it.already = before - it.ids.length;
        it.synced = true;
        if (it.existing) sentTo.put(it.key, { playlistId: it.playlistId, title: it.name });
        saveTransfer();
      } catch (e) {
        if (it.existing && (e.reason === "playlistNotFound" || e.status === 404)) {
          // Deleted on YouTube since last time: make a new playlist with the same name instead.
          if (sentTo.all()[it.key]?.playlistId === it.playlistId) sentTo.drop(it.key);
          Object.assign(it, { playlistId: null, url: null, existing: false, synced: true, gone: true });
          saveTransfer();
        } else {
          halt(T, e);
          break;
        }
      }
    }
    if (it.mode === "playlist" && !it.playlistId && it.next < it.ids.length) {
      if (state.run.cancelled) { T.status = "stopped"; break; }
      progress(`Creating playlist “${it.name}”…`);
      try {
        it.playlistId = await withRetry(() => yt.createPlaylist(it.name, it.description, it.privacy));
        it.url = playlistUrl(it.playlistId);
        sentTo.put(it.key, { playlistId: it.playlistId, title: it.name });
        saveTransfer();
      } catch (e) {
        halt(T, e);
        break;
      }
    }
    while (it.next < it.ids.length) {
      if (state.run.cancelled) { T.status = "stopped"; break outer; }
      const vid = it.ids[it.next];
      progress(`${it.mode === "like" ? "Liking songs for" : "Adding songs to"} “${it.name}”…`);
      try {
        if (it.mode === "like") await withRetry(() => yt.like(vid));
        else await withRetry(() => yt.addItem(it.playlistId, vid), { retryPlaylistNotFound: it.added === 0 && !it.existing });
        it.added++;
      } catch (e) {
        if (!SKIPPABLE.has(e.reason)) { halt(T, e); break outer; }
        it.failed.push(vid);
      }
      it.next++;
      saveTransfer();
    }
  }
  if (T.status === "running") T.status = "done";
  saveTransfer();
  endRun({ done: "Transfer finished", paused: "Transfer paused" }[T.status]);
  setTape(T.status === "done" ? 1 : total() ? done() / total() : 0, false);
  setTransport({ done: "Done", paused: "Paused", stopped: "Stopped" }[T.status] || "Error");
  renderDone();
}

// Google's quota resets at midnight Pacific time.
function quotaReset() {
  const now = new Date();
  const pt = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 0, 0);
  const ms = Math.max(0, midnight - pt);
  return { ms, at: new Date(now.getTime() + ms) };
}

function reminderIcs() {
  const start = new Date(quotaReset().at.getTime() + 5 * 60_000);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const text = (s) => s.replace(/[\\;,]/g, (c) => "\\" + c);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Dubdeck//Transfer reminder//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid()}@dubdeck`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(new Date(start.getTime() + 15 * 60_000))}`,
    `SUMMARY:${text("Continue your Dubdeck transfer")}`,
    `DESCRIPTION:${text(`Google's daily limit has reset. Open ${location.origin} in the same browser and press Continue transfer.`)}`,
    `URL:${location.origin}/`,
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M", `DESCRIPTION:${text("Continue your Dubdeck transfer")}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

let countdownTimer;
function renderCountdown() {
  const { ms, at } = quotaReset();
  const mins = Math.ceil(ms / 60_000);
  $("#countdown-h").textContent = String(Math.floor(mins / 60)).padStart(2, "0");
  $("#countdown-m").textContent = String(mins % 60).padStart(2, "0");
  const shared = !gauth.usingOwn() && !!state.config.google_client_id;
  $("#paused-text").textContent =
    `Google's daily limit is used up${shared ? " (this site's limit is shared by everyone using it)" : ""}. ` +
    `It resets at midnight Pacific time, in ${mins >= 60 ? `about ${plural(Math.round(mins / 60), "hour")}` : plural(mins, "minute")} ` +
    `(around ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} your time). ` +
    "Your progress is saved in this browser: come back then and press Continue transfer.";
}

const itemFinished = (it) => it.synced !== false && it.next >= it.ids.length && (it.mode === "like" || !!it.playlistId || !it.ids.length);

function renderDone() {
  const T = state.transfer;
  if (!T) return goAdd();
  if (T.status === "running" && !state.run) { T.status = "paused"; T.reason = "interrupted"; saveTransfer(); }
  const total = T.items.reduce((a, it) => a + it.ids.length, 0);
  const added = T.items.reduce((a, it) => a + it.added, 0);
  const already = T.items.reduce((a, it) => a + (it.already || 0), 0);
  setCounter(added);

  $("#done-title").textContent = { done: "Transfer finished", paused: "Transfer paused", stopped: "Transfer stopped" }[T.status] || "Transfer stopped early";
  $("#done-lede").textContent = [
    `${added.toLocaleString()} of ${plural(total, "song")} added to YouTube Music.`,
    already ? `${plural(already, "song")} ${already === 1 ? "was" : "were"} already there, so ${already === 1 ? "it was" : "they were"} skipped.` : "",
    T.status === "done" ? "Playlists can take a minute to appear in your library." : "",
  ].filter(Boolean).join(" ");

  const unfinished = T.items.some((it) => !itemFinished(it));
  const quota = unfinished && T.reason === "quota";
  $("#paused").hidden = !unfinished;
  $("#countdown").hidden = $("#remind").hidden = !quota;
  $("#own-project-quota").hidden = !quota || gauth.usingOwn() || !state.config.google_client_id;
  clearInterval(countdownTimer);
  if (quota) {
    renderCountdown();
    countdownTimer = setInterval(() => (state.view === "done" ? renderCountdown() : clearInterval(countdownTimer)), 20_000);
  } else if (unfinished) {
    let text;
    if (T.reason === "auth") text = "Sign in with Google to carry on. Press Continue transfer.";
    else if (T.reason === "network") text = "Lost the connection to YouTube. Press Continue transfer to retry from where it stopped.";
    else if (T.reason === "interrupted") text = "The page was closed during the transfer. Press Continue transfer to pick up where it stopped.";
    else if (T.status === "stopped") text = "You stopped the transfer. Press Continue transfer to carry on.";
    else text = `${T.message || "Something went wrong."} Press Continue transfer to try again.`;
    $("#paused-text").textContent = text;
  }
  if (!document.hidden) document.title = quota ? `Paused · ${BASE_TITLE}` : BASE_TITLE; // keep endRun's note in a background tab

  $("#results").replaceChildren(
    ...T.items.map((it) => {
      const pl = state.review?.playlists[it.pi];
      const failed = new Set(it.failed);
      const pending = new Set(it.ids.slice(it.next));
      const missed = pl
        ? pl.tracks.filter((t) => !t.pick || !t.sel || failed.has(t.pick.videoId)).map((t) => `${t.spotify.artists.join(", ")} - ${t.spotify.title}`)
        : [];
      const parts = it.mode === "like"
        ? [`${plural(it.added, "song")} liked of ${it.ids.length.toLocaleString()}`]
        : [`${it.added.toLocaleString()} of ${plural(it.ids.length, it.existing ? "new song" : "song")} added`];
      if (it.already) parts.push(`${it.already.toLocaleString()} already there`);
      if (it.dupes) parts.push(`${plural(it.dupes, "duplicate")} skipped`);
      let meta = parts.join(", ") + ".";
      if (pending.size) meta += ` ${plural(pending.size, "song")} still to go.`;
      if (it.gone) meta += " The playlist it went to last time was deleted, so this is a new one.";
      const panel = h("article", { class: "panel result" },
        h("div", { class: "result-head" },
          h("div", {}, h("p", { class: "result-name", text: it.name }), h("p", { class: "result-meta", text: meta })),
          it.url ? h("a", { class: "key key-primary", href: it.url, target: "_blank", rel: "noopener" }, it.mode === "like" ? "Open liked music" : "Open in YouTube Music") : null
        ),
        h("div", { class: "bar", role: "img", "aria-label": `${it.added} of ${it.ids.length} added` },
          h("i", { style: `width:${it.ids.length ? Math.round((it.added / it.ids.length) * 100) : 100}%` }))
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
  $("#download-csv-done").hidden = !state.review;
  show("done");
}

$("#resume").addEventListener("click", () => runTransfer());
$("#remind").addEventListener("click", () => downloadFile("dubdeck-reminder.ics", reminderIcs(), "text/calendar;charset=utf-8"));
$("#own-project-quota").addEventListener("click", () => showGoogleSetup());
$("#download-csv-done").addEventListener("click", downloadMatches);

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
