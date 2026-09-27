// Kortpermen – Pokémon-samling med venner. Data: Supabase. Kort og priser: TCGdex (Cardmarket).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { parseLines, matchRefs } from "./parse.js";

const SUPABASE_URL = "https://xzpqpxcdroisomakujgn.supabase.co";
const SUPABASE_KEY = "sb_publishable_hWJfoYxF2fGN_x-DqsvPgA_Grg_yRPK"; // offentlig nøgle, sikkerheden ligger i RLS
const API = "https://api.tcgdex.net/v2/en";
const DKK_RATE = 7.46;
const PRICE_TTL = 24 * 3600e3;
const SET_TTL = 3 * 24 * 3600e3;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------- små hjælpere ----------------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch { try { localStorage.removeItem("kp-prices"); localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  },
};
const S = {
  session: null, me: null,
  sets: [], setsById: {},
  currency: store.get("kp-currency", "EUR"),
  prices: store.get("kp-prices", {}),       // card_id -> {t, cm, rarity}
  token: 0,                                  // skifter ved hver visning, så gamle hentninger stopper
  grid: { view: "binder", filter: "all", sort: "num", q: "" },
  addText: store.get("kp-addtext", ""),
};
const fmt = eur => {
  if (eur == null || isNaN(eur)) return "–";
  const v = S.currency === "DKK" ? eur * DKK_RATE : eur;
  return new Intl.NumberFormat("da-DK", { style: "currency", currency: S.currency, maximumFractionDigits: 2 }).format(v);
};
const firstPos = (...xs) => { for (const x of xs) if (typeof x === "number" && x > 0) return x; return null; };
const priceFromCm = cm => cm ? firstPos(cm.trend, cm["trend-holo"], cm.avg, cm["avg-holo"], cm.low, cm["low-holo"]) : null;
const priceFromRow = r => r ? firstPos(+r.trend, +r.trend_holo, +r.low, +r.low_holo) : null;
const cardPrice = id => priceFromCm(S.prices[id]?.cm);
const setStatus = (msg, err) => { const s = $("#status"); s.textContent = msg || ""; s.classList.toggle("err", !!err); };
const numKey = n => { const m = String(n).match(/^(\D*)(\d+)(.*)$/); return m ? [m[1], +m[2], m[3]] : [String(n), 0, ""]; };
const cmpNum = (a, b) => { const x = numKey(a.localId), y = numKey(b.localId); return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2].localeCompare(y[2]); };
const cmpCard = (a, b) => (a._order - b._order) || cmpNum(a, b);   // sæt i udgivelsesrækkefølge, så nummer
const imgUrl = (c, q = "low") => c?.image ? `${c.image}/${q}.webp` : null;
const cmSlug = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[&'’:.,!?()]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const cmLink = (name, setName) => `https://www.cardmarket.com/en/Pokemon/Products/Singles/${cmSlug(setName)}?searchString=${encodeURIComponent(name)}&language=1`;
const cmSearch = name => `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(name)}&language=1`;
const setIdOf = cardId => cardId.replace(/-[^-]+$/, "");
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pokeName = s => s.trim().replace(/\s+/g, " ").replace(/^\p{L}/u, c => c.toUpperCase());

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function fetchIn(build, ids) { // .in() i bidder, så URL'en ikke bliver for lang
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await build().in("card_id", ids.slice(i, i + 150));
    if (error) throw error;
    out.push(...data);
  }
  return out;
}

// ---------------- sæt og kort fra TCGdex ----------------
const POCKET_RE = /^([AB]\d+[a-z]?|P-[A-Z])$/;
async function loadSets() {
  let cached = store.get("kp-sets", null);
  if (!cached || Date.now() - cached.t > SET_TTL) {
    try {
      const [list, pocket] = await Promise.all([getJSON(`${API}/sets`), getJSON(`${API}/series/tcgp`).catch(() => ({ sets: [] }))]);
      cached = { t: Date.now(), list, pocket: (pocket.sets || []).map(s => s.id) };
      store.set("kp-sets", cached);
    } catch (e) {
      if (!cached) { setStatus("Kunne ikke hente sæt fra TCGdex (" + e.message + ").", true); return; }
    }
  }
  const pocket = new Set(cached.pocket || []);
  S.sets = cached.list.filter(s => !POCKET_RE.test(s.id) && !pocket.has(s.id));
  S.setsById = Object.fromEntries(S.sets.map((s, i) => [s.id, { ...s, order: i }]));
}
const decorate = (c, setId) => { const s = S.setsById[setId]; return { ...c, _setId: setId, _setName: s?.name || setId, _order: s?.order ?? 9999 }; };
async function getSet(id) {
  let c = store.get("kp-set-" + id, null);
  if (!c || Date.now() - c.t > SET_TTL) {
    try { c = { t: Date.now(), d: await getJSON(`${API}/sets/${encodeURIComponent(id)}`) }; store.set("kp-set-" + id, c); }
    catch (e) { if (!c) throw e; }
  }
  return c.d;
}
// Alle engelske, fysiske kort af én Pokémon (fx "Mew" giver Mew ex og Mew & Mewtwo-GX, men ikke Mewtwo)
async function getPokemonCards(name) {
  const key = "kp-poke-" + name.toLowerCase();
  let c = store.get(key, null);
  if (!c || Date.now() - c.t > SET_TTL) {
    try { c = { t: Date.now(), list: await getJSON(`${API}/cards?name=${encodeURIComponent(name)}`) }; store.set(key, c); }
    catch (e) { if (!c) throw e; }
  }
  const re = new RegExp(`(^|[^\\p{L}])${escRe(name)}($|[^\\p{L}])`, "iu");
  return (c.list || []).filter(x => re.test(x.name) && S.setsById[setIdOf(x.id)]).map(x => decorate(x, setIdOf(x.id))).sort(cmpCard);
}
async function loadPrices(cards, force, onProgress) {
  const token = S.token;
  const todo = cards.filter(c => force || !S.prices[c.id] || Date.now() - S.prices[c.id].t > PRICE_TTL);
  let i = 0, done = 0, failed = 0;
  const worker = async () => {
    while (i < todo.length && token === S.token) {
      const c = todo[i++];
      try {
        const d = await getJSON(`${API}/cards/${encodeURIComponent(c.id)}`);
        S.prices[c.id] = { t: Date.now(), cm: d.pricing?.cardmarket || null, rarity: d.rarity || null };
      } catch { failed++; }
      done++;
      if (done % 12 === 0 || done === todo.length) { store.set("kp-prices", S.prices); if (token === S.token) onProgress?.(done, todo.length); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  store.set("kp-prices", S.prices);
  return { total: todo.length, failed };
}

// ---------------- Supabase ----------------
async function loadMe() {
  const { data, error } = await sb.from("profiles").select("*").eq("id", S.session.user.id).maybeSingle();
  if (error) throw error;
  S.me = data;
}
async function userByName(name) {
  if (!name || name === S.me.username) return S.me;
  const { data } = await sb.from("profiles").select("*").eq("username", name).maybeSingle();
  return data;
}
let snapTimer = null;
function scheduleSnapshot() { // beder serveren hente dagens priser for nye kort
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => sb.functions.invoke("snapshot-prices", { body: {} }).catch(() => {}), 8000);
}
async function saveQty(id, n) {
  return n
    ? sb.from("collection").upsert({ user_id: S.me.id, card_id: id, qty: n })
    : sb.from("collection").delete().eq("user_id", S.me.id).eq("card_id", id);
}

// ---------------- routing ----------------
// #/samling[/bruger]  #/saet[/sæt[/bruger]]  #/pokemon[/navn[/bruger]]  #/tilfoej  #/venner
function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] || "samling", a: parts[1], b: parts[2] };
}
async function render() {
  S.token++;
  setStatus("");
  if (!S.session) return renderAuth();
  if (!S.me) { try { await loadMe(); } catch (e) { setStatus("Kunne ikke hente din profil: " + e.message, true); return; } }
  $("#nav").hidden = false; $("#logout").hidden = false; $("#who").hidden = false; $("#who").textContent = S.me.username;
  const r = route();
  document.querySelectorAll("[data-nav]").forEach(a => a.setAttribute("aria-current", a.dataset.nav === r.page ? "page" : "false"));
  if (!S.sets.length) await loadSets();
  try {
    if (r.page === "saet") return await renderSet(r.a, r.b);
    if (r.page === "pokemon") return r.a ? await renderPokemon(r.a, r.b) : await renderPokemonHub();
    if (r.page === "tilfoej") return renderAdd();
    if (r.page === "venner") return await renderFriends();
    if (r.page === "konto") return renderAccount();
    return await renderOverview(r.a);
  } catch (e) { console.error(e); setStatus("Noget gik galt: " + e.message, true); }
}

// ---------------- login ----------------
function renderAuth() {
  $("#nav").hidden = true; $("#logout").hidden = true; $("#who").hidden = true;
  let mode = "login";
  const draw = () => {
    $("#app").innerHTML = `
      <section class="auth">
        <div><h1>Kortpermen</h1><p>Hold styr på dine Pokémon-kort, se hvad de er værd, og se dine venners samlinger.</p></div>
        <div class="seg" role="group" aria-label="Vælg">
          <button data-mode="login" aria-pressed="${mode === "login"}">Log ind</button>
          <button data-mode="signup" aria-pressed="${mode === "signup"}">Opret bruger</button>
        </div>
        <form class="panel" id="authform">
          ${mode === "signup" ? `<label>Brugernavn <input type="text" id="f-user" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_æøåÆØÅ]{3,24}" autocomplete="username"><small class="hint" style="margin:0">3–24 tegn: bogstaver, tal og _. Dine venner ser det.</small></label>` : ""}
          <label>E-mail <input type="email" id="f-email" required autocomplete="email"></label>
          <label>Adgangskode <input type="password" id="f-pass" required minlength="8" autocomplete="${mode === "signup" ? "new-password" : "current-password"}"></label>
          <button class="btn primary" type="submit">${mode === "signup" ? "Opret bruger" : "Log ind"}</button>
          ${mode === "login" ? `<button class="linkbtn" type="button" id="forgot">Glemt adgangskode?</button>` : ""}
          <p class="msg" id="authmsg"></p>
        </form>
      </section>`;
    document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { mode = b.dataset.mode; draw(); });
    if ($("#forgot")) $("#forgot").onclick = async () => {
      const msg = $("#authmsg"), email = $("#f-email").value.trim();
      if (!email) { msg.className = "msg err"; msg.textContent = "Skriv din e-mail i feltet ovenfor først."; $("#f-email").focus(); return; }
      msg.className = "msg"; msg.textContent = "Et øjeblik…";
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) { msg.className = "msg err"; msg.textContent = error.message; }
      else msg.textContent = "Hvis der findes en bruger med den e-mail, har vi sendt et link. Klik på det for at vælge en ny adgangskode.";
    };
    $("#authform").onsubmit = async e => {
      e.preventDefault();
      const msg = $("#authmsg"); msg.className = "msg"; msg.textContent = "Et øjeblik…";
      const email = $("#f-email").value.trim(), password = $("#f-pass").value;
      if (mode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) { msg.className = "msg err"; msg.textContent = error.message === "Invalid login credentials" ? "Forkert e-mail eller adgangskode." : error.message; }
      } else {
        const username = $("#f-user").value.trim();
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username }, emailRedirectTo: location.origin + location.pathname } });
        if (error) { msg.className = "msg err"; msg.textContent = /database error/i.test(error.message) ? "Brugernavnet er taget eller ugyldigt. Prøv et andet." : error.message; }
        else if (!data.session) { msg.textContent = "Tjek din e-mail og klik på linket for at bekræfte din bruger. Så kan du logge ind."; }
      }
    };
  };
  draw();
}

// ---------------- min samling / en vens samling ----------------
async function renderOverview(username) {
  const token = S.token;
  const user = await userByName(username);
  if (!user) { $("#app").innerHTML = `<p class="empty">Brugeren "${esc(username)}" findes ikke.</p>`; return; }
  const mine = user.id === S.me.id;
  $("#app").innerHTML = `<p class="empty">Henter samling…</p>`;
  const [rows, tracked] = await Promise.all([
    fetchAll(() => sb.from("collection").select("card_id,qty,set_id").eq("user_id", user.id)),
    sb.from("tracked_pokemon").select("name").eq("user_id", user.id).order("created_at").then(r => r.data || []),
  ]);
  if (token !== S.token) return;

  const ids = rows.map(r => r.card_id), latest = {};
  for (const p of await fetchIn(() => sb.from("latest_prices").select("card_id,trend,low,trend_holo,low_holo,day"), ids)) latest[p.card_id] = p;
  if (token !== S.token) return;
  const priceOf = id => priceFromRow(latest[id]) ?? cardPrice(id);

  const bySet = {};
  let copies = 0, value = 0, noPrice = 0;
  for (const r of rows) {
    (bySet[r.set_id] ||= { own: 0, value: 0 });
    bySet[r.set_id].own++; copies += r.qty;
    const p = priceOf(r.card_id);
    if (p) { bySet[r.set_id].value += p * r.qty; value += p * r.qty; } else noPrice++;
  }
  const setIds = Object.keys(bySet).sort((a, b) => (S.setsById[b]?.order ?? -1) - (S.setsById[a]?.order ?? -1));
  const ownedSet = new Set(ids);

  const top = rows.map(r => ({ ...r, p: priceOf(r.card_id) })).filter(r => r.p).sort((a, b) => b.p - a.p).slice(0, 5);
  let names = {};
  if (top.length) {
    const { data } = await sb.from("cards").select("card_id,name,set_name,local_id,image").in("card_id", top.map(t => t.card_id));
    names = Object.fromEntries((data || []).map(c => [c.card_id, c]));
  }
  if (token !== S.token) return;
  const userPart = mine ? "" : "/" + encodeURIComponent(user.username);
  const days = Object.values(latest).map(p => p.day).sort();

  $("#app").innerHTML = `
    ${mine ? "" : `<div class="viewing">Du ser <b>${esc(user.username)}</b>s samling.</div>`}
    <div class="pagehead"><h1>${mine ? "Min samling" : esc(user.username)}</h1><span class="grow"></span>
      ${mine ? `<a class="btn" href="#/tilfoej">Hurtig registrering</a><a class="btn primary" href="#/saet">Tilføj kort</a>` : ""}</div>
    <div class="stats">
      <div class="stat"><small>Forskellige kort</small><b>${rows.length}</b></div>
      <div class="stat"><small>Kort i alt</small><b>${copies}</b></div>
      <div class="stat"><small>Samlet værdi${noPrice ? ` (${noPrice} uden pris endnu)` : ""}</small><b>${fmt(value)}</b></div>
      <div class="stat"><small>Sæt i gang</small><b>${setIds.length}</b></div>
    </div>
    <div class="grid2">
      <section class="stack">
        ${tracked.length || mine ? `<div>
          <p class="label">Mastersets</p>
          <ul class="setlist" id="ov-masters">${tracked.map(t => `<li><a href="#/pokemon/${encodeURIComponent(t.name)}${userPart}" data-master="${esc(t.name)}">
            <span class="mono-badge">${esc(t.name.slice(0, 2))}</span>
            <span><span class="n">${esc(t.name)}</span><br><span class="s">Henter kort…</span></span><span class="v"></span>
            <span class="progress"><i style="width:0%"></i></span></a></li>`).join("")}
            ${mine && !tracked.length ? `<li><a href="#/pokemon"><span class="mono-badge">+</span><span><span class="n">Start et masterset</span><br><span class="s">Saml alle kort af din yndlings-Pokémon</span></span><span></span></a></li>` : ""}
          </ul></div>` : ""}
        <div>
          <p class="label">Sæt</p>
          ${setIds.length ? `<ul class="setlist">${setIds.map(id => {
            const s = S.setsById[id], total = s?.cardCount?.total || 0, own = bySet[id].own, pct = total ? Math.min(100, own / total * 100) : 0;
            return `<li><a href="#/saet/${encodeURIComponent(id)}${userPart}">
              ${s?.logo ? `<img src="${esc(s.logo)}.webp" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : "<span></span>"}
              <span><span class="n">${esc(s?.name || id)}</span><br><span class="s">${own} af ${total || "?"} kort</span></span>
              <span class="v">${fmt(bySet[id].value)}</span>
              <span class="progress"><i style="width:${pct}%"></i></span></a></li>`;
          }).join("")}</ul>` : `<div class="panel"><p class="empty" style="margin:0">${mine ? `Du har ikke registreret nogen kort endnu. <a href="#/tilfoej">Skriv dem ind på én gang</a> eller <a href="#/saet">vælg et sæt</a>.` : "Ingen kort registreret endnu."}</p></div>`}
        </div>
      </section>
      <section class="panel">
        <p class="label">Mest værdifulde kort</p>
        ${top.length ? `<ul class="topcards">${top.map(t => { const c = names[t.card_id];
          return `<li>${c?.image ? `<img src="${esc(c.image)}/low.webp" alt="" loading="lazy">` : "<span></span>"}
            <span><span class="n">${esc(c?.name || t.card_id)}</span><br><span class="s">${esc(c?.set_name || t.set_id)} · ${esc(c?.local_id || "")}${t.qty > 1 ? " · ×" + t.qty : ""}</span></span>
            <span class="v">${fmt(t.p)}</span></li>`; }).join("")}</ul>` : `<p class="empty">Priserne kommer, når opsamlingen har kørt.</p>`}
        <p class="hint">Værdien bygger på Cardmarkets trendpris${days.length ? `, senest opdateret ${new Date(days[days.length - 1]).toLocaleDateString("da-DK")}` : ""}. Nye kort får pris inden for en time.</p>
      </section>
    </div>`;

  // fremskridt for mastersets (kortlisterne hentes fra TCGdex og caches)
  for (const t of tracked) {
    getPokemonCards(t.name).then(cards => {
      if (token !== S.token) return;
      const a = document.querySelector(`[data-master="${CSS.escape(t.name)}"]`); if (!a) return;
      const own = cards.filter(c => ownedSet.has(c.id)).length, pct = cards.length ? own / cards.length * 100 : 0;
      a.querySelector(".s").textContent = `${own} af ${cards.length} kort · ${new Set(cards.map(c => c._setId)).size} sæt`;
      a.querySelector(".progress i").style.width = pct + "%";
    }).catch(() => {});
  }
}

// ---------------- konto ----------------
function renderAccount() {
  const recovering = S.recovery;
  $("#app").innerHTML = `
    <div class="pagehead"><h1>Min konto</h1></div>
    ${recovering ? `<div class="viewing">Du er logget ind via linket fra mailen. Vælg en ny adgangskode herunder.</div>` : ""}
    <div class="grid2">
      <form class="panel auth-form" id="pw-form">
        <p class="label">Skift adgangskode</p>
        <label>Ny adgangskode <input type="password" id="pw1" required minlength="8" autocomplete="new-password"></label>
        <label>Gentag ny adgangskode <input type="password" id="pw2" required minlength="8" autocomplete="new-password"></label>
        <button class="btn primary" type="submit">Gem ny adgangskode</button>
        <p class="msg" id="pw-msg"></p>
      </form>
      <section class="panel">
        <p class="label">Oplysninger</p>
        <dl class="kv"><dt>Brugernavn</dt><dd>${esc(S.me.username)}</dd><dt>E-mail</dt><dd>${esc(S.session.user.email)}</dd>
          <dt>Oprettet</dt><dd>${new Date(S.me.created_at).toLocaleDateString("da-DK")}</dd></dl>
      </section>
    </div>`;
  $("#pw-form").onsubmit = async e => {
    e.preventDefault();
    const msg = $("#pw-msg"), a = $("#pw1").value, b = $("#pw2").value;
    if (a !== b) { msg.className = "msg err"; msg.textContent = "De to adgangskoder er ikke ens."; return; }
    msg.className = "msg"; msg.textContent = "Gemmer…";
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) {
      msg.className = "msg err";
      msg.textContent = /same/i.test(error.message) ? "Den nye adgangskode skal være forskellig fra den gamle."
        : /reauth|recent/i.test(error.message) ? "Log ud og ind igen, og prøv så at skifte adgangskoden." : error.message;
      return;
    }
    S.recovery = false;
    $("#pw1").value = ""; $("#pw2").value = "";
    msg.className = "msg"; msg.textContent = "Din adgangskode er skiftet.";
  };
}

// ---------------- venner ----------------
async function renderFriends() {
  const token = S.token;
  const { data, error } = await sb.from("user_stats").select("*").order("username");
  if (error) throw error;
  if (token !== S.token) return;
  $("#app").innerHTML = `
    <div class="pagehead"><h1>Venner</h1></div>
    <p class="empty" style="margin-top:0">Alle med en bruger på siden. Send adressen til dine venner, så de kan oprette sig.</p>
    <div class="friends">${data.map(u => `
      <a href="#/samling${u.id === S.me.id ? "" : "/" + encodeURIComponent(u.username)}">
        <span class="n">${esc(u.username)}${u.id === S.me.id ? `<span class="tag">dig</span>` : ""}</span>
        <span class="s">${u.distinct_cards} forskellige kort · ${u.copies} i alt · ${u.sets} sæt</span>
      </a>`).join("")}</div>`;
}

// ---------------- hurtig registrering ----------------
function renderAdd() {
  let mode = store.get("kp-addmode", "add"), parsed = null;
  $("#app").innerHTML = `
    <div class="pagehead"><h1>Hurtig registrering</h1></div>
    <div class="grid2">
      <section class="stack">
        <div class="panel stack">
          <label class="label" for="add-text">Skriv sæt og kortnumre</label>
          <textarea id="add-text" rows="9" spellcheck="false" placeholder="151: 1, 4, 6, 25x2, 199&#10;PAL 12-18&#10;Crown Zenith GG01-GG05 TG5"></textarea>
          <div class="hrow">
            <div class="seg" role="group" aria-label="Antal">
              <button data-mode="add" aria-pressed="${mode === "add"}">Læg til det jeg har</button>
              <button data-mode="set" aria-pressed="${mode === "set"}">Sæt antal præcist</button>
            </div>
            <span class="grow"></span>
            <button class="btn primary" id="add-preview">Forhåndsvis</button>
          </div>
        </div>
        <div id="add-result"></div>
      </section>
      <aside class="panel help">
        <p class="label">Sådan skriver du</p>
        <ul>
          <li><code>151: 1, 4, 6</code> sæt, kolon og numre</li>
          <li><code>PAL 12-18</code> sætkode og et interval</li>
          <li><code>25x2</code> eller <code>25 x2</code> to styk</li>
          <li><code>TG05</code>, <code>GG12</code> specialnumre</li>
          <li>En linje uden sæt bruger sættet fra linjen over</li>
        </ul>
        <p>Sættet kan være navnet (<i>Paldea Evolved</i>), en del af navnet (<i>paldea</i>), koden (<i>PAL</i>) eller TCGdex-id'et (<i>sv02</i>).</p>
        <p>Koder: SVI, PAL, OBF, MEW, PAR, PAF, TEF, TWM, SFA, SCR, SSP, PRE, JTG, DRI, BLK, WHT, MEG, PFL, samt Sword &amp; Shield og Sun &amp; Moon (fx BRS, CRZ, EVS, CEC).</p>
      </aside>
    </div>`;
  const ta = $("#add-text");
  ta.value = S.addText;
  ta.oninput = () => { S.addText = ta.value; store.set("kp-addtext", ta.value); };
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { mode = b.dataset.mode; store.set("kp-addmode", mode);
    document.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", x === b)); if (parsed) show(); });

  async function preview() {
    const token = S.token;
    $("#add-result").innerHTML = `<p class="empty">Finder kortene…</p>`;
    const lines = parseLines(ta.value, S.sets);
    const setIds = [...new Set(lines.filter(l => l.set).map(l => l.set.id))];
    const setData = {};
    await Promise.all(setIds.map(async id => { try { setData[id] = await getSet(id); } catch { setData[id] = null; } }));
    const items = new Map(), problems = [];
    for (const l of lines) {
      if (l.error) { problems.push(`${l.line}: ${l.error}`); continue; }
      const sd = setData[l.set.id];
      if (!sd) { problems.push(`${l.line}: kunne ikke hente sættet ${l.set.name}`); continue; }
      const { found, missing } = matchRefs(l.refs, sd.cards || []);
      for (const f of found) { const c = decorate(f.card, l.set.id); const cur = items.get(c.id); items.set(c.id, { card: c, qty: (cur?.qty || 0) + f.qty }); }
      if (missing.length) problems.push(`${l.set.name}: findes ikke: ${missing.join(", ")}`);
      if (l.bad.length) problems.push(`${l.line}: forstod ikke: ${l.bad.join(", ")}`);
      if (!l.refs.length && !l.bad.length) problems.push(`${l.line}: ingen kortnumre`);
    }
    const ids = [...items.keys()];
    const existing = Object.fromEntries((await fetchIn(() => sb.from("collection").select("card_id,qty").eq("user_id", S.me.id), ids)).map(r => [r.card_id, r.qty]));
    if (token !== S.token) return;
    parsed = { items: [...items.values()].sort(cmpCard), problems, existing };
    show();
  }
  function show() {
    const { items, problems, existing } = parsed;
    const newQty = it => Math.min(999, mode === "add" ? (existing[it.card.id] || 0) + it.qty : it.qty);
    const copies = items.reduce((s, it) => s + it.qty, 0);
    $("#add-result").innerHTML = `
      ${problems.length ? `<div class="panel problems"><p class="label">Tjek disse</p><ul>${problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      ${items.length ? `<div class="panel stack">
        <div class="hrow"><b>${items.length} kort fundet${copies !== items.length ? ` (${copies} styk)` : ""}</b><span class="grow"></span>
          <button class="btn primary" id="add-commit">Gem i min samling</button></div>
        <ul class="addlist">${items.map(it => { const had = existing[it.card.id] || 0, nq = newQty(it);
          return `<li>${it.card.image ? `<img src="${esc(imgUrl(it.card))}" alt="" loading="lazy">` : "<span></span>"}
            <span><span class="n">${esc(it.card.name)}</span><br><span class="s">${esc(it.card._setName)} · ${esc(it.card.localId)}</span></span>
            <span class="q">${had ? `${had} → ` : ""}<b>${nq}</b></span></li>`; }).join("")}</ul>
      </div>` : (problems.length ? "" : `<p class="empty">Skriv noget i feltet først.</p>`)}`;
    const btn = $("#add-commit");
    if (btn) btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "Gemmer…";
      const payload = items.map(it => ({ user_id: S.me.id, card_id: it.card.id, qty: newQty(it) }));
      let error = null;
      for (let i = 0; i < payload.length && !error; i += 500) ({ error } = await sb.from("collection").upsert(payload.slice(i, i + 500)));
      if (error) { btn.disabled = false; btn.textContent = "Gem i min samling"; setStatus("Kunne ikke gemme: " + error.message, true); return; }
      scheduleSnapshot();
      S.addText = ""; store.set("kp-addtext", ""); ta.value = "";
      $("#add-result").innerHTML = `<div class="panel"><p style="margin:0"><b>${payload.length} kort gemt.</b> <a href="#/samling">Se min samling</a> eller skriv flere ovenfor.</p></div>`;
      parsed = null;
    };
  }
  $("#add-preview").onclick = preview;
  ta.onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); preview(); } };
}

// ---------------- mastersets ----------------
async function renderPokemonHub() {
  const token = S.token;
  const [{ data: tracked }, rows] = await Promise.all([
    sb.from("tracked_pokemon").select("name").eq("user_id", S.me.id).order("created_at"),
    fetchAll(() => sb.from("collection").select("card_id").eq("user_id", S.me.id)),
  ]);
  if (token !== S.token) return;
  const owned = new Set(rows.map(r => r.card_id));
  $("#app").innerHTML = `
    <div class="pagehead"><h1>Mastersets</h1></div>
    <form class="panel hrow" id="poke-form">
      <label for="poke-q" class="sr">Pokémon</label>
      <input type="text" id="poke-q" placeholder="Skriv en Pokémon, fx Charizard, Umbreon eller Pikachu" required style="flex:1 1 240px">
      <button class="btn primary" type="submit">Vis alle kort</button>
    </form>
    <p class="hint">Et masterset er alle engelske kort med Pokémonen i navnet på tværs af alle sæt, fx også Charizard ex, Dark Charizard og tag team-kort. Kort, du allerede har registreret i et sæt, tæller automatisk med.</p>
    <div style="height:14px"></div>
    <p class="label">Mine mastersets</p>
    ${tracked?.length ? `<ul class="setlist">${tracked.map(t => `<li><a href="#/pokemon/${encodeURIComponent(t.name)}" data-master="${esc(t.name)}">
      <span class="mono-badge">${esc(t.name.slice(0, 2))}</span><span><span class="n">${esc(t.name)}</span><br><span class="s">Henter kort…</span></span><span class="v"></span>
      <span class="progress"><i style="width:0%"></i></span></a></li>`).join("")}</ul>` : `<p class="empty">Du har ikke gemt nogen mastersets endnu. Søg en Pokémon frem og tryk "Gem som masterset".</p>`}`;
  $("#poke-form").onsubmit = e => { e.preventDefault(); const n = pokeName($("#poke-q").value); if (n) location.hash = "#/pokemon/" + encodeURIComponent(n); };
  for (const t of tracked || []) {
    getPokemonCards(t.name).then(cards => {
      if (token !== S.token) return;
      const a = document.querySelector(`[data-master="${CSS.escape(t.name)}"]`); if (!a) return;
      const own = cards.filter(c => owned.has(c.id)).length;
      a.querySelector(".s").textContent = `${own} af ${cards.length} kort · ${new Set(cards.map(c => c._setId)).size} sæt`;
      a.querySelector(".progress i").style.width = (cards.length ? own / cards.length * 100 : 0) + "%";
    }).catch(() => {});
  }
}

async function renderPokemon(rawName, username) {
  const token = S.token;
  const name = pokeName(rawName);
  const user = await userByName(username);
  if (!user) { $("#app").innerHTML = `<p class="empty">Brugeren findes ikke.</p>`; return; }
  const mine = user.id === S.me.id;
  $("#app").innerHTML = `<p class="empty">Finder alle ${esc(name)}-kort…</p>`;
  const cards = await getPokemonCards(name);
  if (token !== S.token) return;
  if (!cards.length) {
    $("#app").innerHTML = `<div class="pagehead"><h1>${esc(name)}</h1></div><div class="panel"><p class="empty" style="margin:0">Fandt ingen engelske kort med "${esc(name)}" i navnet. Tjek stavningen (engelsk navn, fx <i>Charizard</i> og ikke <i>Glurak</i>). <a href="#/pokemon">Prøv igen</a></p></div>`;
    return;
  }
  const [rows, trackedRes] = await Promise.all([
    fetchIn(() => sb.from("collection").select("card_id,qty").eq("user_id", user.id), cards.map(c => c.id)),
    sb.from("tracked_pokemon").select("name").eq("user_id", S.me.id).eq("name", name).maybeSingle(),
  ]);
  if (token !== S.token) return;
  const owned = Object.fromEntries(rows.map(r => [r.card_id, r.qty]));
  let tracked = !!trackedRes.data;
  const nSets = new Set(cards.map(c => c._setId)).size;
  const trackBtn = () => `<button class="btn${tracked ? "" : " primary"}" id="track">${tracked ? "Fjern fra mine mastersets" : "Gem som masterset"}</button>`;
  renderGrid({
    user, mine, cards, owned, context: "pokemon",
    head: `
      ${mine ? "" : `<div class="viewing">Du ser <b>${esc(user.username)}</b>s ${esc(name)}-kort. <a href="#/pokemon/${encodeURIComponent(name)}">Se dine egne</a></div>`}
      <div class="pagehead">
        <div><h1>${esc(name)} masterset</h1><div class="meta">${cards.length} engelske kort fra ${nSets} sæt · normalversioner (reverse holo tælles ikke separat)</div></div>
        <span class="grow"></span><span id="trackwrap">${trackBtn()}</span>
      </div>`,
    onReady() {
      const wire = () => { $("#track").onclick = async () => {
        const res = tracked
          ? await sb.from("tracked_pokemon").delete().eq("user_id", S.me.id).eq("name", name)
          : await sb.from("tracked_pokemon").insert({ user_id: S.me.id, name });
        if (res.error) return setStatus("Kunne ikke gemme: " + res.error.message, true);
        tracked = !tracked; $("#trackwrap").innerHTML = trackBtn(); wire();
        setStatus(tracked ? `${name} er gemt under dine mastersets.` : `${name} er fjernet fra dine mastersets. Dine kort er ikke slettet.`);
      }; };
      wire();
    },
  });
}

// ---------------- sæt ----------------
async function renderSet(setId, username) {
  const token = S.token;
  if (!setId) {
    const last = store.get("kp-current", null);
    const pick = (last && S.setsById[last]) ? last : (S.sets.find(s => s.name === "151") || S.sets[S.sets.length - 1])?.id;
    if (pick) location.replace("#/saet/" + encodeURIComponent(pick)); else $("#app").innerHTML = `<p class="empty">Ingen sæt fundet.</p>`;
    return;
  }
  const user = await userByName(username);
  if (!user) { $("#app").innerHTML = `<p class="empty">Brugeren findes ikke.</p>`; return; }
  const mine = user.id === S.me.id;
  if (mine) store.set("kp-current", setId);
  $("#app").innerHTML = `<p class="empty">Henter sættet…</p>`;
  const [set, owned] = await Promise.all([
    getSet(setId),
    fetchAll(() => sb.from("collection").select("card_id,qty").eq("user_id", user.id).eq("set_id", setId))
      .then(rows => Object.fromEntries(rows.map(r => [r.card_id, r.qty]))),
  ]);
  if (token !== S.token) return;
  const userPart = mine ? "" : "/" + encodeURIComponent(user.username);
  const optList = q => S.sets.filter(s => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)).slice().reverse()
    .map(s => `<option value="${esc(s.id)}"${s.id === setId ? " selected" : ""}>${esc(s.name)} (${esc(s.id)})</option>`).join("") || "<option disabled>Ingen sæt matcher</option>";
  const rel = set.releaseDate ? new Date(set.releaseDate).toLocaleDateString("da-DK", { year: "numeric", month: "long" }) : "";
  renderGrid({
    user, mine, owned, context: "set",
    cards: (set.cards || []).map(c => ({ ...c, _setId: setId, _setName: set.name, _order: 0 })),
    officialCount: set.cardCount?.official,
    head: `
      ${mine ? "" : `<div class="viewing">Du ser <b>${esc(user.username)}</b>s perm. <a href="#/saet/${encodeURIComponent(setId)}">Se din egen</a></div>`}
      <div class="setpick">
        <input type="search" id="set-q" placeholder="Søg efter sæt, fx 151 eller Evolving" aria-label="Søg efter sæt">
        <select id="set-sel" aria-label="Vælg sæt">${optList("")}</select>
      </div>
      <div class="pagehead">
        ${set.logo ? `<img src="${esc(set.logo)}.webp" alt="" onerror="this.remove()">` : ""}
        <div><h1>${esc(set.name)}</h1><div class="meta">${esc(set.serie?.name || "")}${rel ? " · " + esc(rel) : ""} · ${set.cardCount?.official ?? "?"} officielle kort + ${Math.max(0, (set.cardCount?.total ?? 0) - (set.cardCount?.official ?? 0))} secret</div></div>
      </div>`,
    onReady() {
      $("#set-q").oninput = e => { $("#set-sel").innerHTML = optList(e.target.value.trim().toLowerCase()); };
      $("#set-sel").onchange = e => { location.hash = "#/saet/" + encodeURIComponent(e.target.value) + userPart; };
    },
  });
}

// ---------------- fælles perm (bruges af sæt og mastersets) ----------------
function renderGrid({ user, mine, cards, owned, context, head, onReady, officialCount }) {
  const token = S.token, G = S.grid, multi = context === "pokemon";
  $("#app").innerHTML = `${head}
    <div class="stats" id="g-stats"></div>
    <div class="controls">
      <div class="seg" role="group" aria-label="Visning">
        <button data-view="binder" aria-pressed="${G.view === "binder"}">Perm</button>
        <button data-view="list" aria-pressed="${G.view === "list"}">Mangler-liste</button>
      </div>
      <div class="seg" role="group" aria-label="Filter">
        <button data-filter="all" aria-pressed="${G.filter === "all"}">Alle</button>
        <button data-filter="missing" aria-pressed="${G.filter === "missing"}">Mangler</button>
        <button data-filter="owned" aria-pressed="${G.filter === "owned"}">Har</button>
      </div>
      <select id="g-sort" aria-label="Sortering">
        <option value="num">Sortér: ${multi ? "sæt og nummer" : "nummer"}</option><option value="price-desc">Sortér: dyreste først</option>
        <option value="price-asc">Sortér: billigste først</option><option value="name">Sortér: navn</option>
      </select>
      <input type="search" id="g-q" placeholder="${multi ? "Søg kort eller sæt" : "Søg kort i sættet"}" aria-label="Søg kort" value="${esc(G.q)}">
      <button class="btn" id="g-refresh">Opdatér priser</button>
    </div>
    <div id="g-content"></div>`;
  $("#g-sort").value = G.sort;

  const stats = () => {
    let own = 0, ownVal = 0, miss = 0, missVal = 0, missNo = 0;
    for (const c of cards) { const p = cardPrice(c.id), q = owned[c.id] || 0;
      if (q) { own++; if (p) ownVal += p * q; } else { miss++; if (p) missVal += p; else missNo++; } }
    const pct = cards.length ? Math.round(own / cards.length * 100) : 0;
    $("#g-stats").innerHTML = `
      <div class="stat"><small>${mine ? "Samlet" : esc(user.username) + " har"}</small><b>${own} / ${cards.length}</b><div class="progress"><i style="width:${pct}%"></i></div></div>
      <div class="stat"><small>Værdi</small><b>${fmt(ownVal)}</b></div>
      <div class="stat missing"><small>Pris for de ${miss} manglende${missNo ? ` (${missNo} uden pris)` : ""}</small><b>${fmt(missVal)}</b></div>`;
  };
  const visible = () => {
    let list = cards.slice(); const q = G.q.toLowerCase();
    if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || String(c.localId).toLowerCase() === q || (multi && c._setName.toLowerCase().includes(q)));
    if (G.view === "list" || G.filter === "missing") list = list.filter(c => !owned[c.id]);
    else if (G.filter === "owned") list = list.filter(c => owned[c.id]);
    const sort = G.view === "list" && G.sort === "num" ? "price-desc" : G.sort;
    if (sort === "num") list.sort(cmpCard);
    else if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name) || cmpCard(a, b));
    else list.sort((a, b) => { const x = cardPrice(a.id), y = cardPrice(b.id);
      if (x == null && y == null) return cmpCard(a, b); if (x == null) return 1; if (y == null) return -1;
      return sort === "price-asc" ? x - y : y - x; });
    return list;
  };
  const content = () => {
    const el = $("#g-content"); if (!el) return;
    const list = visible();
    if (G.view === "list") {
      let sum = 0, noP = 0;
      const rows = list.map(c => { const p = cardPrice(c.id); if (p) sum += p; else noP++; const cm = S.prices[c.id]?.cm;
        return `<tr><td>${c.image ? `<img class="thumb" loading="lazy" src="${esc(imgUrl(c))}" alt="">` : ""}</td>
          ${multi ? `<td>${esc(c._setName)}</td>` : ""}<td class="num">${esc(c.localId)}</td><td>${esc(c.name)}</td><td>${esc(S.prices[c.id]?.rarity || "")}</td>
          <td class="num">${fmt(firstPos(cm?.low, cm?.["low-holo"]))}</td><td class="num"><b>${fmt(p)}</b></td>
          <td class="num">${fmt(firstPos(cm?.avg30, cm?.["avg30-holo"]))}</td>
          <td><a href="${esc(cmLink(c.name, c._setName))}" target="_blank" rel="noopener">Cardmarket ↗</a></td>
          ${mine ? `<td><button class="btn small" data-have="${esc(c.id)}">Har den</button></td>` : ""}</tr>`; }).join("");
      const cols = 8 + (multi ? 1 : 0) + (mine ? 1 : 0);
      el.innerHTML = list.length ? `<div class="tablewrap"><table>
        <thead><tr><th></th>${multi ? "<th>Sæt</th>" : ""}<th class="num">Nr.</th><th>Kort</th><th>Sjældenhed</th><th class="num">Laveste</th><th class="num">Trend</th><th class="num">Snit 30 d.</th><th></th>${mine ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="${multi ? 3 : 2}"></td><td colspan="3">${list.length} kort mangler${noP ? ` · ${noP} uden pris` : ""}</td><td class="num">${fmt(sum)}</td><td colspan="${cols - (multi ? 3 : 2) - 4}"></td></tr></tfoot>
        </table></div>` : `<p class="empty">Du har dem alle. Flot!</p>`;
      return;
    }
    if (!list.length) { el.innerHTML = `<p class="empty">Ingen kort matcher filteret.</p>`; return; }
    el.innerHTML = `<div class="binder">${list.map(c => {
      const q = owned[c.id] || 0, p = cardPrice(c.id), img = imgUrl(c);
      return `<div class="pocket${q ? " owned" : ""}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)} ${esc(c.localId)}${q ? ", har " + q : ""}">
        ${q > 1 ? `<span class="badge">×${q}</span>` : ""}
        <div class="img">${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : `<span class="noimg">Intet billede</span>`}</div>
        ${multi ? `<div class="setline">${esc(c._setName)}</div>` : ""}
        <div class="row"><span class="nm">${esc(c.name)}</span><span class="no">${esc(c.localId)}</span></div>
        <div class="row"><span class="pr${p == null ? " none" : ""}">${p == null ? (S.prices[c.id] ? "ingen pris" : "…") : fmt(p)}</span>
          ${mine ? `<span class="qty">${q ? `<button data-act="dec" aria-label="Færre">−</button><span>${q}</span>` : ""}<button data-act="inc" aria-label="${q ? "Flere" : "Tilføj til samling"}">+</button></span>` : ""}</div>
      </div>`; }).join("")}</div>
      <p class="hint">${mine ? "Tryk + og − for at registrere dine kort. Klik på et kort for detaljer og Cardmarket-link." : "Klik på et kort for detaljer og Cardmarket-link."}</p>`;
  };
  const all = () => { stats(); content(); };

  async function setQty(id, n) {
    n = Math.max(0, Math.min(999, n));
    const before = owned[id] || 0;
    if (n) owned[id] = n; else delete owned[id];
    all();
    const res = await saveQty(id, n);
    if (res.error) { if (before) owned[id] = before; else delete owned[id]; all(); setStatus("Kunne ikke gemme: " + res.error.message, true); }
    else scheduleSnapshot();
  }
  function detail(id) {
    const c = cards.find(x => x.id === id); if (!c) return;
    const dlg = $("#dlg");
    const draw = () => {
      const cm = S.prices[id]?.cm || {}, q = owned[id] || 0;
      const row = (l, k) => (typeof cm[k] === "number" && cm[k] > 0 ? `<dt>${l}</dt><dd>${fmt(cm[k])}</dd>` : "");
      const rows = row("Trend", "trend") + row("Laveste", "low") + row("Snit 7 dage", "avg7") + row("Snit 30 dage", "avg30") +
        row("Trend (holo/reverse)", "trend-holo") + row("Laveste (holo/reverse)", "low-holo") + row("Snit 30 d. (holo/reverse)", "avg30-holo");
      const off = context === "set" ? officialCount : S.setsById[c._setId]?.cardCount?.official;
      dlg.innerHTML = `<button class="close" aria-label="Luk">×</button><div class="dlg">
        ${c.image ? `<img src="${esc(imgUrl(c, "high"))}" alt="${esc(c.name)}">` : "<div></div>"}
        <div><h3>${esc(c.name)}</h3>
          <div class="meta">${esc(c._setName)} · ${esc(c.localId)}/${off ?? "?"}${S.prices[id]?.rarity ? " · " + esc(S.prices[id].rarity) : ""}</div>
          <dl class="pl">${rows || "<dt>Ingen Cardmarket-pris for dette kort</dt><dd></dd>"}</dl>
          <div class="acts">
            ${mine ? `<button class="btn primary" data-dq="1">${q ? "Tilføj en mere" : "Jeg har den"}</button>${q ? `<button class="btn" data-dq="-1">Fjern en (${q})</button>` : ""}` : ""}
            <a class="btn" href="${esc(cmLink(c.name, c._setName))}" target="_blank" rel="noopener">Se kortet på Cardmarket ↗</a>
            <a class="btn" href="${esc(cmSearch(c.name))}" target="_blank" rel="noopener">Søg i alle sæt ↗</a>
            ${multi ? `<a class="btn" href="#/saet/${encodeURIComponent(c._setId)}">Åbn sættet</a>` : ""}
          </div>
          <p class="hint">Priser: Cardmarkets prisguide via TCGdex, alle sprog samlet. Linket viser engelske kort.</p></div></div>`;
    };
    draw();
    dlg.onclick = async e => {
      if (e.target === dlg || e.target.closest(".close")) return dlg.close();
      if (e.target.closest("a[href^='#']")) return dlg.close();
      const b = e.target.closest("[data-dq]"); if (b) { await setQty(id, (owned[id] || 0) + +b.dataset.dq); draw(); }
    };
    dlg.showModal();
  }

  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { G.view = b.dataset.view;
    document.querySelectorAll("[data-view]").forEach(x => x.setAttribute("aria-pressed", x === b)); content(); });
  document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { G.filter = b.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(x => x.setAttribute("aria-pressed", x === b)); content(); });
  $("#g-sort").onchange = e => { G.sort = e.target.value; content(); };
  $("#g-q").oninput = e => { G.q = e.target.value.trim(); content(); };
  $("#g-content").onclick = e => {
    const have = e.target.closest("[data-have]"); if (have) return setQty(have.dataset.have, 1);
    const pocket = e.target.closest(".pocket"); if (!pocket) return;
    const id = pocket.dataset.id, act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "inc") return setQty(id, (owned[id] || 0) + 1);
    if (act === "dec") return setQty(id, (owned[id] || 0) - 1);
    detail(id);
  };
  $("#g-content").onkeydown = e => { const p = e.target.closest?.(".pocket");
    if (p && e.target === p && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); detail(p.dataset.id); } };
  const refresh = async force => {
    $("#g-refresh").disabled = true;
    const r = await loadPrices(cards, force, (d, t) => { setStatus(`Henter priser… ${d}/${t}`); all(); });
    if (token !== S.token) return;
    $("#g-refresh").disabled = false; all();
    setStatus(r.failed ? `${r.failed} kort kunne ikke hentes. Tryk "Opdatér priser" for at prøve igen.` : "", !!r.failed);
  };
  $("#g-refresh").onclick = () => refresh(true);
  onReady?.();
  all();
  refresh(false);
}

// ---------------- opstart ----------------
const setCur = c => { S.currency = c; store.set("kp-currency", c);
  $("#cur-eur").setAttribute("aria-pressed", c === "EUR"); $("#cur-dkk").setAttribute("aria-pressed", c === "DKK"); };
$("#cur-eur").onclick = () => { setCur("EUR"); render(); };
$("#cur-dkk").onclick = () => { setCur("DKK"); render(); };
$("#logout").onclick = async () => { await sb.auth.signOut(); };
setCur(S.currency);

window.addEventListener("hashchange", render);
sb.auth.onAuthStateChange((event, session) => {
  const was = S.session?.user?.id, now = session?.user?.id;
  S.session = session;
  if (event === "PASSWORD_RECOVERY") { S.recovery = true; location.hash = "#/konto"; }
  if (was !== now) { S.me = null; setTimeout(render, 0); }
});
const { data: { session } } = await sb.auth.getSession();
S.session = session;
render();
