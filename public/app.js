// Dubdeck front end. Plain JS, no build step.
//
// Spotify is read straight from the browser (PKCE login, no server involved).
// YouTube Music calls go through the stateless /api/ytm/* endpoints, carrying the
// user's headers from this browser. All state lives in localStorage.

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
  constructor(message, status) { super(message); this.status = status; }
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

// ------------------------------------------------------------------ state

const state = {
  config: { spotify_client_id: null },
  playlists: [],
  selected: new Set(store.get("selected", [])),
  review: store.get("review"), // { playlists: [...], errors }
  filter: "all",
  openAlt: null, // "pi:ti"
  shown: {}, // pi -> rows shown
  run: null, // { kind, cancelled } while matching / transferring
};
const matchCache = new Map(); // spotify track key -> match result, for this tab

// ------------------------------------------------------------------ Spotify (browser-side)

const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative user-library-read";
const LIKED_ID = "liked";

function redirectUri() {
  const origin = location.hostname === "localhost" ? location.origin.replace("//localhost", "//127.0.0.1") : location.origin;
  return `${origin}/callback.html`;
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const spotify = {
  clientId() { return store.get("spotify.clientId") || state.config.spotify_client_id || null; },
  token() { return store.get("spotify.token"); },
  user() { return store.get("spotify.user"); },
  connected() { const t = this.token(); return !!t && t.client_id === this.clientId(); },

  logout() { store.del("spotify.token"); store.del("spotify.user"); },

  async login() {
    if (location.hostname === "localhost") {
      // Spotify only accepts 127.0.0.1 for local redirect URIs; keep storage on one origin.
      location.href = location.href.replace("//localhost", "//127.0.0.1");
      return;
    }
    const verifier = randomString(64);
    const st = randomString(16);
    sessionStorage.setItem("dubdeck:pkce", JSON.stringify({ verifier, state: st }));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    location.href = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id: this.clientId(),
      response_type: "code",
      redirect_uri: redirectUri(),
      code_challenge_method: "S256",
      code_challenge: challenge,
      scope: SPOTIFY_SCOPES,
      state: st,
    });
  },

  /** Finish the login if Spotify just sent us back. Returns true if this was a callback. */
  async handleCallback() {
    const p = new URLSearchParams(location.search);
    if (!p.has("state")) return false;
    history.replaceState(null, "", "/");
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem("dubdeck:pkce") || "null"); } catch {}
    sessionStorage.removeItem("dubdeck:pkce");
    if (p.get("error")) {
      flash(p.get("error") === "access_denied" ? "Spotify login was cancelled." : `Spotify login failed: ${p.get("error")}`);
      return true;
    }
    if (!saved || saved.state !== p.get("state") || !p.get("code")) {
      flash("That Spotify login expired. Choose Connect Spotify again.");
      return true;
    }
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: p.get("code"),
        redirect_uri: redirectUri(),
        client_id: this.clientId(),
        code_verifier: saved.verifier,
      }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
      flash(`Spotify login failed: ${data.error_description || data.error || "network error"}`);
      return true;
    }
    this._save(data);
    return true;
  },

  _save(tok) {
    const old = this.token() || {};
    store.set("spotify.token", {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || old.refresh_token,
      expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
      client_id: this.clientId(),
    });
  },

  _refreshing: null,
  async refresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const t = this.token();
      if (!t?.refresh_token) throw this._expired();
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: this.clientId() }),
      }).catch(() => null);
      if (!res || !res.ok) throw this._expired();
      this._save(await res.json());
    })().finally(() => (this._refreshing = null));
    return this._refreshing;
  },

  _expired() {
    this.logout();
    return new HttpError("Your Spotify session expired. Connect Spotify again.", 401);
  },

  async accessToken() {
    const t = this.token();
    if (!t) throw new HttpError("Spotify is not connected.", 401);
    if (t.expires_at - Date.now() < 60_000) await this.refresh();
    return this.token().access_token;
  },

  async get(path, params) {
    let url = path.startsWith("http") ? path : SPOTIFY_API + path;
    if (params) url += "?" + new URLSearchParams(params);
    let refreshed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken()}` } }).catch(() => null);
      if (!res) { await sleep(1500 * (attempt + 1)); continue; }
      if (res.ok) return res.json();
      if (res.status === 401 && !refreshed) { await this.refresh(); refreshed = true; continue; }
      if (res.status === 429) { await sleep(Math.min(Number(res.headers.get("Retry-After")) || 5, 60) * 1000); continue; }
      if (res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw this._expired();
      throw new HttpError(`Spotify said: ${body?.error?.message || res.statusText} (${res.status})`, res.status);
    }
    throw new HttpError("Spotify kept failing (rate limited or unavailable). Try again in a minute.", 503);
  },

  async paginate(path, params, onPage) {
    const out = [];
    let page = await this.get(path, params);
    for (;;) {
      out.push(...(page.items || []));
      onPage?.(out.length, page.total || out.length);
      if (!page.next) return out;
      page = await this.get(page.next);
    }
  },

  async me() {
    const d = await this.get("/me");
    const user = { id: d.id, name: d.display_name || d.id };
    store.set("spotify.user", user);
    return user;
  },

  async playlists() {
    const me = this.user() || (await this.me());
    const liked = await this.get("/me/tracks", { limit: 1 });
    const out = [{ id: LIKED_ID, name: "Liked Songs", description: "", image: null, owner: me.name, total: liked.total || 0, readable: true, liked: true }];
    for (const p of await this.paginate("/me/playlists", { limit: 50 })) {
      if (!p) continue;
      const owner = p.owner || {};
      // the playlist's track summary was renamed from "tracks" to "items" in Feb 2026
      const summary = (p.items && !Array.isArray(p.items) ? p.items : p.tracks) || {};
      out.push({
        id: p.id,
        name: p.name || "Untitled",
        description: decodeEntities(p.description || ""),
        image: p.images?.[0]?.url || null,
        owner: owner.display_name || owner.id || "",
        total: summary.total || 0,
        readable: owner.id === me.id || !!p.collaborative,
        liked: false,
      });
    }
    return out;
  },

  async tracks(id, onProgress) {
    let entries;
    try {
      entries = id === LIKED_ID
        ? await this.paginate("/me/tracks", { limit: 50 }, onProgress)
        : await this.paginate(`/playlists/${id}/items`, { limit: 50, additional_types: "track" }, onProgress);
    } catch (e) {
      if (e.status === 403 && id !== LIKED_ID) {
        throw new HttpError("Spotify only lets apps read playlists you own or collaborate on. Copy it into one of your own playlists first.", 403);
      }
      throw e;
    }
    return entries.map(toTrack).filter(Boolean);
  },
};

function toTrack(entry) {
  const t = entry?.item || entry?.track;
  if (!t || (t.type && t.type !== "track") || !t.name) return null; // episodes, removed tracks
  return {
    id: t.id || null,
    title: t.name,
    artists: (t.artists || []).map((a) => a.name).filter(Boolean),
    album: t.album?.name || "",
    duration_sec: t.duration_ms ? t.duration_ms / 1000 : null,
    isrc: t.external_ids?.isrc || null,
  };
}

function decodeEntities(s) {
  const ta = document.createElement("textarea");
  ta.innerHTML = s;
  return ta.value;
}

// ------------------------------------------------------------------ YouTube Music (via stateless API)

const ytm = {
  auth() { return store.get("ytm.auth"); },
  account() { return store.get("ytm.account"); },
  connected() { return !!this.auth(); },
  async connect(raw) {
    const { auth, account } = await api("/api/ytm/connect", { method: "POST", body: { headers: raw } });
    store.set("ytm.auth", auth);
    store.set("ytm.account", account);
  },
  disconnect() { store.del("ytm.auth"); store.del("ytm.account"); },
  async call(path, body, { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api(path, { method: "POST", body: { auth: this.auth(), ...body } });
      } catch (e) {
        if (e.status === 401) {
          this.disconnect();
          renderDecks();
          renderSetup();
          throw e;
        }
        const transient = e.status === 0 || e.status >= 500;
        if (!transient || attempt >= retries) throw e;
        await sleep(1500 * (attempt + 1));
      }
    }
  },
};

const bothConnected = () => spotify.connected() && ytm.connected();

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
  setLabels("Spotify", "YouTube Music");
  setTape(0, false);
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

function setTransport(text) {
  $("#transport-status").textContent = text;
}

function resetDeck() {
  setCounter(0);
  setTape(0, false);
  setTransport("Ready");
  setLabels("Spotify", "YouTube Music");
}

// ------------------------------------------------------------------ views

const STEP_OF = { connect: 0, choose: 1, working: 2, review: 2, transferring: 3, done: 3 };

function show(view) {
  const id = view === "transferring" ? "working" : view;
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${id}`));
  const current = STEP_OF[view];
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

function renderActionBar() {
  const bar = $("#actionbar"), btn = $("#action-btn"), sum = $("#action-summary");
  btn.replaceChildren();
  if (state.view === "choose") {
    const chosen = state.playlists.filter((p) => state.selected.has(p.id) && p.readable);
    const tracks = chosen.reduce((a, p) => a + (p.total || 0), 0);
    bar.hidden = false;
    sum.replaceChildren(
      chosen.length
        ? h("span", {}, h("strong", { text: plural(chosen.length, "playlist") }), ` selected, ${plural(tracks, "song")}`)
        : "Select the playlists you want to copy."
    );
    btn.append("Find matches");
    btn.disabled = !chosen.length;
    btn.onclick = startMatch;
  } else if (state.view === "review" && state.review) {
    const pls = state.review.playlists.filter((pl) => pl.tracks.some((t) => t.sel && t.pick));
    const n = state.review.playlists.reduce((a, pl) => a + pl.tracks.filter((t) => t.sel && t.pick).length, 0);
    bar.hidden = false;
    sum.replaceChildren(
      n ? h("span", {}, h("strong", { text: plural(n, "song") }), ` ready to go into ${plural(pls.length, "playlist")}`) : "No songs are selected."
    );
    btn.append(h("span", { class: "rec-dot", "aria-hidden": "true" }), "Transfer to YouTube Music");
    btn.disabled = !n;
    btn.onclick = startTransfer;
  } else {
    bar.hidden = true;
  }
}

// ------------------------------------------------------------------ accounts & setup

function renderDecks() {
  const spOn = spotify.connected(), ytOn = ytm.connected();
  $("#bay-a").dataset.state = spOn ? "on" : "off";
  $("#acct-a").textContent = spOn ? spotify.user()?.name || "Connected" : spotify.clientId() ? "Ready to connect" : "Not set up";
  $("#disc-a").hidden = !spOn;
  $("#bay-b").dataset.state = ytOn ? "on" : "off";
  $("#acct-b").textContent = ytOn ? ytm.account()?.name || "Connected" : "Not connected";
  $("#disc-b").hidden = !ytOn;
}

function renderSetup() {
  const spOn = spotify.connected(), cid = spotify.clientId();
  $("#redirect-uri").textContent = redirectUri();
  $("#redirect-uri-2").textContent = redirectUri();
  $("#sp-connected").hidden = !spOn;
  $("#sp-user").textContent = spotify.user()?.name || "";
  const editing = $("#sp-setup").dataset.editing === "1";
  $("#sp-setup").hidden = spOn || (!!cid && !editing);
  $("#sp-ready").hidden = spOn || !cid || editing;
  $("#sp-client-tail").textContent = (cid || "").slice(-4);
  $("#yt-connected").hidden = !ytm.connected();
  $("#yt-user").textContent = ytm.account()?.name || "";
  $("#yt-setup").hidden = ytm.connected();
}

$("#copy-redirect").addEventListener("click", (e) => copyText(redirectUri(), e.currentTarget));

$("#form-client-id").addEventListener("submit", (e) => {
  e.preventDefault();
  clearFlash();
  const id = $("#client-id").value.trim();
  if (!/^[A-Za-z0-9]{16,64}$/.test(id)) {
    flash("That doesn't look like a Spotify Client ID. It's 32 letters and numbers, shown on your app's page.");
    return;
  }
  store.set("spotify.clientId", id);
  spotify.logout();
  $("#sp-setup").dataset.editing = "0";
  renderDecks();
  renderSetup();
});

$("#sp-change").addEventListener("click", () => {
  $("#sp-setup").dataset.editing = "1";
  $("#client-id").value = spotify.clientId() || "";
  renderSetup();
  $("#client-id").focus();
});

$("#sp-login").addEventListener("click", () => spotify.login().catch((e) => flash(e.message)));

$("#form-ytm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFlash();
  const btn = $("#ytm-submit");
  btn.disabled = true;
  btn.textContent = "Checking headers…";
  try {
    await ytm.connect($("#ytm-headers").value);
    $("#ytm-headers").value = "";
    renderDecks();
    renderSetup();
    route();
  } catch (err) {
    flash(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect YouTube Music";
  }
});

$("#disc-a").addEventListener("click", () => { spotify.logout(); renderDecks(); renderSetup(); route(); });
$("#disc-b").addEventListener("click", () => { ytm.disconnect(); renderDecks(); renderSetup(); route(); });

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

function handleAuthError(err) {
  flash(err.message);
  renderDecks();
  renderSetup();
  if (err.status === 401) show("connect");
}

// ------------------------------------------------------------------ choose playlists

const heart = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.6 1.1 5.2 3 1.6-1.9 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z"/>';
  return s;
};

async function loadPlaylists() {
  const list = $("#pl-list");
  list.replaceChildren(h("li", { class: "shelf-empty", text: "Loading your playlists from Spotify…" }));
  try {
    state.playlists = await spotify.playlists();
    const ids = new Set(state.playlists.filter((p) => p.readable).map((p) => p.id));
    state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
    renderPlaylists();
  } catch (err) {
    list.replaceChildren(h("li", { class: "shelf-empty", text: "Couldn't load playlists." }));
    handleAuthError(err);
  }
}

function renderPlaylists() {
  const q = $("#pl-filter").value.trim().toLowerCase();
  const items = state.playlists.filter((p) => !q || p.name.toLowerCase().includes(q));
  const list = $("#pl-list");
  if (!items.length) {
    list.replaceChildren(h("li", { class: "shelf-empty", text: q ? "No playlists match that filter." : "No playlists found on this Spotify account." }));
  } else {
    list.replaceChildren(...items.map(playlistItem));
  }
  $("#pl-locked-note").hidden = !state.playlists.some((p) => !p.readable);
  renderActionBar();
}

function coverFor(p) {
  if (p.liked) return h("span", { class: "tape-cover liked" }, heart());
  if (p.image) return h("img", { class: "tape-cover", src: p.image, alt: "", loading: "lazy" });
  return h("span", { class: "tape-cover" });
}

function playlistItem(p) {
  const id = `pl-${p.id}`;
  const meta = p.readable
    ? `${plural(p.total, "song")}${p.liked ? "" : `, by ${p.owner}`}`
    : `${plural(p.total, "song")}, by ${p.owner}. Can't be read.`;
  const input = h("input", {
    type: "checkbox", id, class: "sr-only", checked: state.selected.has(p.id), disabled: !p.readable,
    onchange: (e) => {
      e.target.checked ? state.selected.add(p.id) : state.selected.delete(p.id);
      store.set("selected", [...state.selected]);
      renderActionBar();
    },
  });
  return h("li", {},
    h("label", { class: `tape${p.readable ? "" : " locked"}`, for: id, title: p.readable ? null : "Spotify only lets apps read playlists you own or collaborate on." },
      input, coverFor(p),
      h("span", { class: "tape-body" }, h("span", { class: "tape-name", text: p.name }), h("span", { class: "tape-meta", text: meta })),
      h("span", { class: "led", "aria-hidden": "true" })
    )
  );
}

$("#pl-filter").addEventListener("input", renderPlaylists);
$("#pl-refresh").addEventListener("click", loadPlaylists);
$("#pl-all").addEventListener("click", () => {
  const q = $("#pl-filter").value.trim().toLowerCase();
  const visible = state.playlists.filter((p) => p.readable && (!q || p.name.toLowerCase().includes(q)));
  const allOn = visible.every((p) => state.selected.has(p.id));
  visible.forEach((p) => (allOn ? state.selected.delete(p.id) : state.selected.add(p.id)));
  store.set("selected", [...state.selected]);
  renderPlaylists();
});

// ------------------------------------------------------------------ running work (matching / transfer)

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

const trackKey = (t) => t.id || `${t.title}|${t.artists.join(",")}`;

async function startMatch() {
  clearFlash();
  const pls = state.playlists.filter((p) => state.selected.has(p.id) && p.readable);
  if (!pls.length) return;
  beginRun("match");
  $("#work-title").textContent = "Finding your songs on YouTube Music";
  $("#work-lede").textContent = "Each song is looked up by its recording code first, then by title, artist and length. Keep this tab open.";
  setLabels(pls.length === 1 ? pls[0].name : `${pls.length} playlists`, "YouTube Music");
  show("working");

  // 1. read the playlists from Spotify
  const loaded = [];
  const errors = [];
  for (const [i, pl] of pls.entries()) {
    if (state.run.cancelled) break;
    const label = `Reading “${pl.name}” from Spotify (${i + 1} of ${pls.length})…`;
    tick({ label, done: 0, total: 0, verb: "Reading…" });
    try {
      const tracks = await spotify.tracks(pl.id, (d, t) => tick({ label, done: d, total: t }));
      loaded.push({ pl, tracks, rows: new Array(tracks.length) });
    } catch (err) {
      if (err.status === 401) { state.run = null; setTape(0, false); return handleAuthError(err); }
      errors.push({ playlist: pl.name, error: err.message });
    }
  }

  // 2. match on YouTube Music, a few songs per request, two requests at a time
  const queue = [];
  loaded.forEach((L, pi) => L.tracks.forEach((t, ti) => queue.push({ pi, ti, t })));
  const total = queue.length;
  let done = 0;
  const pending = [];
  for (const q of queue) {
    const hit = matchCache.get(trackKey(q.t));
    if (hit) { loaded[q.pi].rows[q.ti] = { spotify: q.t, ...hit }; done++; }
    else pending.push(q);
  }
  tick({ label: "Finding songs on YouTube Music…", done, total });

  let fatal = null;
  async function worker() {
    while (pending.length && !state.run.cancelled && !fatal) {
      const batch = pending.splice(0, 6);
      let results;
      try {
        results = (await ytm.call("/api/ytm/match", { tracks: batch.map((b) => b.t) })).results;
      } catch (err) {
        if (err.status === 401) { fatal = err; return; }
        results = batch.map(() => ({ match: null, candidates: [], error: err.message }));
      }
      batch.forEach((b, k) => {
        const r = results[k];
        loaded[b.pi].rows[b.ti] = { spotify: b.t, ...r };
        if (!r.error) matchCache.set(trackKey(b.t), r);
      });
      done += batch.length;
      tick({ label: `Matching “${loaded[batch[0].pi].pl.name}”…`, done, total });
    }
  }
  await Promise.all([worker(), worker()]);
  const cancelled = state.run.cancelled;
  state.run = null;
  if (fatal) { setTape(0, false); return handleAuthError(fatal); }

  if (!loaded.length) {
    setTape(0, false);
    if (errors.length) flash(errors.map((e) => `${e.playlist}: ${e.error}`).join("\n"));
    return goChoose();
  }

  const playlists = loaded.map(({ pl, tracks, rows }) => ({
    id: pl.id, name: pl.name, description: pl.description, image: pl.image, liked: pl.liked,
    tracks: tracks.map((t, ti) => rows[ti] || { spotify: t, match: null, candidates: [], error: "Stopped before this song was matched." }),
  }));
  setTape(1, false);
  setTransport(cancelled ? "Stopped" : "Matched");
  setLabels("Spotify", "YouTube Music");
  loadReview({ playlists, errors });
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

function loadReview(result) {
  const many = result.playlists.length > 1;
  state.review = {
    errors: result.errors || [],
    playlists: result.playlists.map((pl) => ({
      ...pl,
      outName: pl.liked ? "Liked Songs from Spotify" : pl.name,
      privacy: "PRIVATE",
      mode: "playlist",
      collapsed: many && pl.tracks.length > 60,
      tracks: pl.tracks.map((t) => ({ ...t, pick: t.match, sel: !!t.match && t.match.confidence !== "low" })),
    })),
  };
  store.del("results");
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
    if (state.review && !store.set("review", state.review)) store.del("review"); // too big for this browser: skip
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

function renderReview() {
  renderFilterCounts();
  $("#review-errors").replaceChildren(
    ...state.review.errors.map((e) =>
      h("div", { class: "flash" }, h("span", { class: "led rec", "aria-hidden": "true" }), h("p", {}, h("strong", { text: e.playlist }), `: ${e.error}`))
    )
  );
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
    if (state.openAlt === `${pi}:${ti}`) frag.append(altsRow(pl, pi, t, ti, stats));
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
  return h("span", { class: "dur", title: `Spotify ${fmtTime(t.spotify.duration_sec)}` },
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
      const alt = altsRow(pl, pi, t, ti, stats);
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
      const { candidate } = await ytm.call("/api/ytm/lookup", { url: form.querySelector("input").value });
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

// ------------------------------------------------------------------ transfer

async function startTransfer() {
  clearFlash();
  const items = [];
  state.review.playlists.forEach((pl, pi) => {
    const ids = pl.tracks.filter((t) => t.sel && t.pick).map((t) => t.pick.videoId);
    if (!ids.length) return;
    const description = [pl.description, "Copied from Spotify with Dubdeck."].filter(Boolean).join("\n\n");
    items.push({ pi, name: (pl.outName || pl.name).trim() || pl.name, description, privacy: pl.privacy, mode: pl.mode, ids });
  });
  if (!items.length) return;

  beginRun("transfer");
  $("#work-title").textContent = "Writing playlists to YouTube Music";
  $("#work-lede").textContent = "Playlists are created first, then songs are added in batches of 50. Keep this tab open until it finishes.";
  setLabels(items.length === 1 ? items[0].name : "Spotify", items.length === 1 ? items[0].name : `${items.length} playlists`);
  show("transferring");

  const total = items.reduce((a, i) => a + i.ids.length, 0);
  let done = 0;
  const results = [];
  let stopReason = null;

  for (const item of items) {
    if (state.run.cancelled) break;
    const seen = new Set();
    const vids = item.ids.filter((v) => !seen.has(v) && seen.add(v));
    const res = { pi: item.pi, name: item.name, mode: item.mode, added: 0, failed: [], url: null, duplicates_skipped: item.ids.length - vids.length };
    results.push(res);
    done += res.duplicates_skipped;
    try {
      if (item.mode === "like") {
        res.url = "https://music.youtube.com/playlist?list=LM";
        for (let i = 0; i < vids.length && !state.run.cancelled; i += 20) {
          const chunk = vids.slice(i, i + 20);
          tick({ label: `Liking songs for “${item.name}”…`, done, total });
          const { failed } = await ytm.call("/api/ytm/like", { video_ids: chunk });
          res.failed.push(...failed);
          res.added += chunk.length - failed.length;
          done += chunk.length;
        }
      } else {
        tick({ label: `Creating playlist “${item.name}”…`, done, total });
        const { playlist_id } = await ytm.call("/api/ytm/create", { title: item.name, description: item.description, privacy: item.privacy }, { retries: 0 });
        res.url = `https://music.youtube.com/playlist?list=${playlist_id}`;
        for (let i = 0; i < vids.length && !state.run.cancelled; i += 50) {
          const chunk = vids.slice(i, i + 50);
          tick({ label: `Adding songs to “${item.name}”…`, done, total });
          const { failed } = await ytm.call("/api/ytm/add", { playlist_id, video_ids: chunk });
          res.failed.push(...failed);
          res.added += chunk.length - failed.length;
          done += chunk.length;
        }
      }
    } catch (err) {
      res.error = err.message;
      if (err.status === 401) { stopReason = err; break; }
    }
    tick({ done, total });
  }

  const status = stopReason ? "error" : state.run.cancelled ? "cancelled" : "done";
  state.run = null;
  setTape(1, false);
  setTransport(status === "done" ? "Done" : status === "cancelled" ? "Stopped" : "Error");
  const record = { status, results, done };
  store.set("results", record);
  if (stopReason) flash(stopReason.message);
  showDone(record);
}

function showDone({ status, results, done }) {
  const total = results.reduce((a, r) => a + r.added, 0);
  setCounter(done || total);
  $("#done-title").textContent = status === "cancelled" ? "Transfer stopped" : status === "error" ? "Transfer stopped early" : "Transfer finished";
  $("#done-lede").textContent = `${plural(total, "song")} added to YouTube Music. Playlists can take a minute to appear in your library.`;

  $("#results").replaceChildren(
    ...results.map((r) => {
      const pl = state.review?.playlists[r.pi];
      const failed = new Set(r.failed || []);
      const missed = pl
        ? pl.tracks.filter((t) => !t.pick || !t.sel || failed.has(t.pick.videoId)).map((t) => `${t.spotify.artists.join(", ")} - ${t.spotify.title}`)
        : [];
      const attempted = r.added + (r.failed?.length || 0);
      const meta = r.mode === "like"
        ? `${plural(r.added, "song")} liked`
        : `${r.added.toLocaleString()} of ${plural(attempted, "song")} added${r.duplicates_skipped ? `, ${r.duplicates_skipped} duplicates skipped` : ""}`;
      const panel = h("article", { class: "panel result" },
        h("div", { class: "result-head" },
          h("div", {}, h("p", { class: "result-name", text: r.name }), h("p", { class: "result-meta", text: meta })),
          r.url ? h("a", { class: "key key-primary", href: r.url, target: "_blank", rel: "noopener" }, r.mode === "like" ? "Open liked songs" : "Open in YouTube Music") : null
        )
      );
      if (r.error) panel.append(h("p", { class: "fineprint", text: `Stopped with an error: ${r.error}` }));
      if (missed.length) {
        panel.append(
          h("details", {},
            h("summary", {}, `${plural(missed.length, "song")} didn't make it over`),
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

$("#start-over").addEventListener("click", () => {
  store.del("results");
  store.del("review");
  state.review = null;
  resetDeck();
  goChoose();
});

// ------------------------------------------------------------------ routing & boot

function goChoose() {
  show("choose");
  if (!state.playlists.length) loadPlaylists();
  else renderPlaylists();
}

function route() {
  if (!bothConnected()) return show("connect");
  const results = store.get("results");
  if (results && state.review) {
    setTape(1, false);
    setTransport("Done");
    return showDone(results);
  }
  if (state.review) {
    const n = state.review.playlists.reduce((a, pl) => a + pl.tracks.length, 0);
    setCounter(n);
    setTape(1, false);
    setTransport("Matched");
    renderReview();
    return show("review");
  }
  goChoose();
}

async function boot() {
  mountCassettes();
  try {
    state.config = await api("/api/config");
  } catch (err) {
    flash(err.message);
  }
  try {
    await spotify.handleCallback();
  } catch (err) {
    flash(`Spotify login failed: ${err.message}`);
  }
  if (spotify.connected()) {
    try { await spotify.me(); } catch (err) { flash(err.message); }
  }
  renderDecks();
  renderSetup();
  route();
}

boot();
