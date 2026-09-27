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
  prices: store.get("kp-prices", {}),       // card_id -> {t, cm, rarity, variants}
  token: 0,                                  // skifter ved hver visning, så gamle hentninger stopper
  grid: { view: "binder", filter: "all", sort: "num", q: "", vs: { reverse: true, firstEdition: true, shadowless: true, ...store.get("kp-vs", {}) } },
  addText: store.get("kp-addtext", ""),
  chartRange: store.get("kp-range", "90"),
  overrides: {},                             // card_id -> { reverse: true/false, ... }
};
const fmt = eur => {
  if (eur == null || isNaN(eur)) return "–";
  const v = S.currency === "DKK" ? eur * DKK_RATE : eur;
  return new Intl.NumberFormat("da-DK", { style: "currency", currency: S.currency, maximumFractionDigits: 2 }).format(v);
};
const firstPos = (...xs) => { for (const x of xs) if (typeof x === "number" && x > 0) return x; return null; };
// Cardmarkets "-holo"-felter er reverse holo-prisen; normal/holo-kortet selv står i trend/avg/low.
// De detaljerede varianter fra TCGdex (vd) har egne Cardmarket-produkter, fx shadowless.
const NO_PRICE = new Set(["firstEdition", "shadowless"]);   // ingen felter i den almindelige prisguide
const vdOf = id => S.prices[id]?.vd || [];
const vdFind = (id, v) => {
  const vd = vdOf(id);
  if (v === "shadowless") return vd.find(x => x.s === "shadowless" && !x.st.includes("1st-edition"));
  if (v === "firstEdition") return vd.find(x => x.st.includes("1st-edition"));
  if (v === "reverse") return vd.find(x => x.t === "reverse");
  return vd.find(x => !x.st.length && x.s !== "shadowless" && x.t !== "reverse");
};
const baseProduct = id => vdFind(id, "normal")?.id ?? S.prices[id]?.cm?.idProduct ?? null;
// 1. udgave/shadowless får kun pris, hvis versionen er sit eget produkt på Cardmarket
const ownProductPrice = (id, v) => {
  const x = vdFind(id, v); if (!x || !x.id || x.id === baseProduct(id)) return null;
  if (v === "firstEdition" && x.id === vdFind(id, "shadowless")?.id) return null;   // samme vare som shadowless
  return firstPos(x.tr, x.lo);
};
const priceFromCm = (cm, v = "normal") => !cm || NO_PRICE.has(v) ? null : v === "reverse"
  ? firstPos(cm["trend-holo"], cm["avg-holo"], cm["low-holo"])
  : firstPos(cm.trend, cm.avg, cm.low, cm["trend-holo"], cm["avg-holo"], cm["low-holo"]);
const priceFromRow = (r, v = "normal") => !r || NO_PRICE.has(v) ? null : v === "reverse"
  ? firstPos(+r.trend_holo, +r.low_holo)
  : firstPos(+r.trend, +r.low, +r.trend_holo, +r.low_holo);
const cardPrice = (id, v = "normal") => NO_PRICE.has(v) ? ownProductPrice(id, v) : priceFromCm(S.prices[id]?.cm, v);
const VLABEL = { normal: "Normal", reverse: "Reverse", firstEdition: "1. udgave", shadowless: "Shadowless" };
const VSHORT = { normal: "N", reverse: "R", firstEdition: "1.", shadowless: "S" };
const VORDER = ["firstEdition", "shadowless", "normal", "reverse"];
// Sæt fra før reverse holo fandtes (WOTC) og småserier uden reverse
const PRE_REVERSE = /^(base[1-5]|basep|gym\d|neo\d|si1|wp|tk-|mcd|\d{4})/;
// Hvilke versioner et kort findes i, ud fra TCGdex. Reverse tæller også, hvis Cardmarket har en
// reverse-pris for et ikke-holo kort (TCGdex mangler reverse for mange ældre sæt).
const autoVariants = id => {
  const e = S.prices[id] || {}, v = e.variants || {}, vd = e.vd || [], cm = e.cm || {}, sid = setIdOf(id), out = new Set();
  if (v.firstEdition || vd.some(x => x.st.includes("1st-edition"))) out.add("firstEdition");
  if (sid === "base1" || vd.some(x => x.s === "shadowless")) out.add("shadowless");
  const holoBase = v.holo && !v.normal;
  if (v.reverse || vd.some(x => x.t === "reverse") || (!PRE_REVERSE.test(sid) && !holoBase && firstPos(cm["trend-holo"], cm["avg30-holo"]))) out.add("reverse");
  return out;
};
// + fælles rettelser fra brugerne (variant_overrides)
const variantsOf = id => { const auto = autoVariants(id), ov = S.overrides[id] || {};
  return VORDER.filter(v => v === "normal" || (v in ov ? ov[v] : auto.has(v))); };
const hasReverse = id => variantsOf(id).includes("reverse");
const setStatus = (msg, err) => { const s = $("#status"); s.textContent = msg || ""; s.classList.toggle("err", !!err); };
const numKey = n => { const m = String(n).match(/^(\D*)(\d+)(.*)$/); return m ? [m[1], +m[2], m[3]] : [String(n), 0, ""]; };
const cmpNum = (a, b) => { const x = numKey(a.localId), y = numKey(b.localId); return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2].localeCompare(y[2]); };
const cmpCard = (a, b) => (a._order - b._order) || cmpNum(a, b);   // sæt i udgivelsesrækkefølge, så nummer
const imgUrl = (c, q = "low") => c?.image ? `${c.image}/${q}.webp` : null;
const cmSlug = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[&'’:.,!?()]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const cmLink = (name, setName) => `https://www.cardmarket.com/en/Pokemon/Products/Singles/${cmSlug(setName)}?searchString=${encodeURIComponent(name)}&language=1`;
const cmProduct = pid => `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${pid}&language=1`;
const cmFor = (c, v = "normal") => { const pid = vdFind(c.id, v)?.id || baseProduct(c.id); return pid ? cmProduct(pid) : cmLink(c.name, c._setName); };
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
  const todo = cards.filter(c => force || !S.prices[c.id] || !("vd" in S.prices[c.id]) || Date.now() - S.prices[c.id].t > PRICE_TTL);
  let i = 0, done = 0, failed = 0;
  const worker = async () => {
    while (i < todo.length && token === S.token) {
      const c = todo[i++];
      try {
        const d = await getJSON(`${API}/cards/${encodeURIComponent(c.id)}`);
        const vd = (d.variants_detailed || []).map(x => { const m = x.pricing?.cardmarket;
          return { t: x.type, s: x.subtype || null, st: x.stamp || [], id: m?.idProduct ?? x.thirdParty?.cardmarket ?? null, tr: m?.trend ?? null, lo: m?.low ?? null }; });
        S.prices[c.id] = { t: Date.now(), cm: d.pricing?.cardmarket || null, rarity: d.rarity || null, variants: d.variants || null, vd };
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
async function saveQty(id, variant, n) {
  return n
    ? sb.from("collection").upsert({ user_id: S.me.id, card_id: id, variant, qty: n })
    : sb.from("collection").delete().eq("user_id", S.me.id).eq("card_id", id).eq("variant", variant);
}
// rækker fra collection -> { card_id: { normal: n, reverse: m } }
const toOwned = rows => { const o = {}; for (const r of rows) (o[r.card_id] ||= {})[r.variant || "normal"] = r.qty; return o; };

// ---------------- routing ----------------
// #/samling[/bruger]  #/saet[/sæt[/bruger]]  #/pokemon[/navn[/bruger]]  #/tilfoej  #/venner
function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] || "samling", a: parts[1], b: parts[2] };
}
async function render() {
  S.token++;
  document.body.classList.remove("printing-plan");
  setStatus("");
  if (!S.session) return renderAuth();
  if (!S.me) { try { await loadMe(); } catch (e) { setStatus("Kunne ikke hente din profil: " + e.message, true); return; } }
  $("#nav").hidden = false; $("#logout").hidden = false; $("#who").hidden = false; $("#who").textContent = S.me.username;
  const r = route();
  const navPage = r.page === "scan" ? "tilfoej" : r.page;
  document.querySelectorAll("[data-nav]").forEach(a => a.setAttribute("aria-current", a.dataset.nav === navPage ? "page" : "false"));
  if (!S.sets.length) await loadSets();
  try {
    if (r.page === "saet") return await renderSet(r.a, r.b);
    if (r.page === "pokemon") return r.a ? await renderPokemon(r.a, r.b) : await renderPokemonHub();
    if (r.page === "tilfoej") return renderAdd();
    if (r.page === "scan") return await renderScan();
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
          ${mode === "signup" ? `<label>Invitationskode <input type="text" id="f-invite" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Få den af en ven, der allerede er med"></label>` : ""}
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
        const username = $("#f-user").value.trim(), invite = $("#f-invite").value.trim();
        const check = await sb.rpc("check_signup", { invite_code: invite, new_username: username });
        const why = { invalid_invite: "Invitationskoden er forkert. Spørg den ven, der inviterede dig.", invalid_username: "Brugernavnet skal være 3–24 tegn: bogstaver, tal og _.", username_taken: "Brugernavnet er taget. Prøv et andet." }[check.data];
        if (why) { msg.className = "msg err"; msg.textContent = why; return; }
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username, invite }, emailRedirectTo: location.origin + location.pathname } });
        if (error) { msg.className = "msg err"; msg.textContent = /database error/i.test(error.message) ? "Kunne ikke oprette brugeren. Tjek invitationskoden og brugernavnet." : error.message; }
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
    fetchAll(() => sb.from("collection").select("card_id,qty,set_id,variant").eq("user_id", user.id)),
    sb.from("tracked_pokemon").select("name").eq("user_id", user.id).order("created_at").then(r => r.data || []),
  ]);
  if (token !== S.token) return;

  const ids = [...new Set(rows.map(r => r.card_id))], latest = {};
  for (const p of await fetchIn(() => sb.from("latest_prices").select("card_id,trend,low,trend_holo,low_holo,day"), ids)) latest[p.card_id] = p;
  if (token !== S.token) return;
  const priceOf = (id, v) => priceFromRow(latest[id], v) ?? cardPrice(id, v);

  const bySet = {};
  let copies = 0, value = 0, noPrice = 0, revCount = 0;
  for (const r of rows) {
    const b = (bySet[r.set_id] ||= { cards: new Set(), rev: 0, value: 0 });
    b.cards.add(r.card_id); if (r.variant !== "normal") { b.rev++; revCount++; }
    copies += r.qty;
    const p = priceOf(r.card_id, r.variant);
    if (p) { b.value += p * r.qty; value += p * r.qty; } else noPrice++;
  }
  const setIds = Object.keys(bySet).sort((a, b) => (S.setsById[b]?.order ?? -1) - (S.setsById[a]?.order ?? -1));
  const ownedSet = new Set(ids), revSet = new Set(rows.filter(r => r.variant === "reverse").map(r => r.card_id));

  const top = rows.map(r => ({ ...r, p: priceOf(r.card_id, r.variant) })).filter(r => r.p).sort((a, b) => b.p - a.p).slice(0, 5);
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
      <div class="stat"><small>Forskellige kort${revCount ? ` (+ ${revCount} andre versioner)` : ""}</small><b>${ids.length}</b></div>
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
            const s = S.setsById[id], total = s?.cardCount?.total || 0, own = bySet[id].cards.size, pct = total ? Math.min(100, own / total * 100) : 0;
            return `<li><a href="#/saet/${encodeURIComponent(id)}${userPart}">
              ${s?.logo ? `<img src="${esc(s.logo)}.webp" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : "<span></span>"}
              <span><span class="n">${esc(s?.name || id)}</span><br><span class="s">${own} af ${total || "?"} kort${bySet[id].rev ? ` · +${bySet[id].rev} versioner` : ""}</span></span>
              <span class="v">${fmt(bySet[id].value)}</span>
              <span class="progress"><i style="width:${pct}%"></i></span></a></li>`;
          }).join("")}</ul>` : `<div class="panel"><p class="empty" style="margin:0">${mine ? `Du har ikke registreret nogen kort endnu. <a href="#/tilfoej">Skriv dem ind på én gang</a> eller <a href="#/saet">vælg et sæt</a>.` : "Ingen kort registreret endnu."}</p></div>`}
        </div>
      </section>
      <section class="panel">
        <p class="label">Mest værdifulde kort</p>
        ${top.length ? `<ul class="topcards">${top.map(t => { const c = names[t.card_id];
          return `<li>${c?.image ? `<img src="${esc(c.image)}/low.webp" alt="" loading="lazy">` : "<span></span>"}
            <span><span class="n">${esc(c?.name || t.card_id)}${t.variant !== "normal" ? " · " + VLABEL[t.variant].toLowerCase() : ""}</span><br><span class="s">${esc(c?.set_name || t.set_id)} · ${esc(c?.local_id || "")}${t.qty > 1 ? " · ×" + t.qty : ""}</span></span>
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
      const rev = cards.filter(c => revSet.has(c.id)).length;
      a.querySelector(".s").textContent = `${own} af ${cards.length} kort${rev ? ` · ${rev} reverse` : ""} · ${new Set(cards.map(c => c._setId)).size} sæt`;
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
      <section class="stack">
      <div class="panel">
        <p class="label">Invitér en ven</p>
        <p class="hint" style="margin-top:0">Nye brugere skal bruge denne kode for at oprette sig. Send den sammen med adressen til siden.</p>
        <div class="hrow"><code class="invite" id="inv-code">…</code><button class="btn small" id="inv-copy">Kopiér invitation</button></div>
        <p class="msg" id="inv-msg"></p>
      </div>
      <div class="panel">
        <p class="label">App på telefonen</p>
        ${matchMedia("(display-mode: standalone)").matches ? `<p class="hint" style="margin:0">Du bruger Kortpermen som app.</p>` : `
        <p class="hint" style="margin-top:0">Læg Kortpermen på hjemmeskærmen, så åbner den som en app i fuld skærm.</p>
        ${deferredInstall ? `<button class="btn primary small" id="acc-install">Installér app</button>` : `
        <ol class="install-steps">
          <li><b>iPhone (Safari):</b> tryk på Del-knappen <span aria-hidden="true">⬆︎</span> og vælg <b>Føj til hjemmeskærm</b>.</li>
          <li><b>Android (Chrome):</b> tryk på menuen ⋮ og vælg <b>Installér app</b> eller <b>Føj til startskærm</b>.</li>
        </ol>`}`}
      </div>
      <div class="panel">
        <p class="label">Oplysninger</p>
        <dl class="kv"><dt>Brugernavn</dt><dd>${esc(S.me.username)}</dd><dt>E-mail</dt><dd>${esc(S.session.user.email)}</dd>
          <dt>Oprettet</dt><dd>${new Date(S.me.created_at).toLocaleDateString("da-DK")}</dd></dl>
        <div style="height:12px"></div>
        <button class="btn small" id="acc-logout">Log ud</button>
      </div>
      </section>
    </div>`;
  $("#acc-logout").onclick = () => sb.auth.signOut();
  if ($("#acc-install")) $("#acc-install").onclick = promptInstall;
  sb.rpc("get_invite_code").then(({ data }) => {
    const code = data || "(ingen aktiv kode)";
    $("#inv-code").textContent = code;
    $("#inv-copy").onclick = async () => {
      const text = `Kom med i Kortpermen og hold styr på dine Pokémon-kort: ${location.origin + location.pathname}\nInvitationskode: ${code}`;
      try { await navigator.clipboard.writeText(text); $("#inv-msg").textContent = "Invitationen er kopieret. Indsæt den i en besked til din ven."; }
      catch { const r = document.createRange(); r.selectNodeContents($("#inv-code")); getSelection().removeAllRanges(); getSelection().addRange(r); $("#inv-msg").textContent = "Koden er markeret. Tryk Ctrl+C for at kopiere."; }
    };
  });
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
    <p class="empty" style="margin-top:0">Alle med en bruger på siden. Du finder invitationskoden til nye venner under <a href="#/konto">Min konto</a>.</p>
    <div class="friends">${data.map(u => `
      <a href="#/samling${u.id === S.me.id ? "" : "/" + encodeURIComponent(u.username)}">
        <span class="n">${esc(u.username)}${u.id === S.me.id ? `<span class="tag">dig</span>` : ""}</span>
        <span class="s">${u.distinct_cards} forskellige kort · ${u.copies} i alt · ${u.sets} sæt</span>
      </a>`).join("")}</div>`;
}

// ---------------- kortscanner ----------------
async function renderScan() {
  const { mountScanner } = await import("./scan.js");
  mountScanner($("#app"), { esc, fmt, imgUrl, S, sb, getSet, loadPrices, variantsOf, cardPrice, saveQty, scheduleSnapshot, decorate, VLABEL, setStatus });
}

// ---------------- hurtig registrering ----------------
function renderAdd() {
  let mode = store.get("kp-addmode", "add"), parsed = null;
  $("#app").innerHTML = `
    <div class="pagehead"><h1>Tilføj kort</h1></div>
    <a class="scan-cta" href="#/scan">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><rect x="8.5" y="7" width="7" height="10" rx="1"/></svg>
      <span><b>Scan med kameraet</b><br><small>Hold kortet op, så finder appen det selv</small></span>
    </a>
    <p class="label" style="margin-top:18px">Eller skriv numrene</p>
    <div class="grid2">
      <section class="stack">
        <div class="panel stack">
          <label class="label" for="add-text">Skriv sæt og kortnumre</label>
          <textarea id="add-text" rows="9" spellcheck="false" placeholder="151: 1, 4, 6, 25x2, 199&#10;PAL 12-18, 12-18r&#10;Crown Zenith GG01-GG05 TG5"></textarea>
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
          <li><code>25r</code> reverse holo, fx <code>12-18r</code> eller <code>25rx2</code></li>
          <li><code>4e</code> 1. udgave og <code>4s</code> shadowless, fx <code>Base Set: 4e, 4s, 4</code></li>
          <li><code>TG05</code>, <code>GG12</code> specialnumre</li>
          <li>En linje uden sæt bruger sættet fra linjen over</li>
        </ul>
        <p>Sættet kan være navnet (<i>Paldea Evolved</i>), en del af navnet (<i>paldea</i>), koden (<i>PAL</i>) eller TCGdex-id'et (<i>sv02</i>).</p>
        <p>Koder: SVI, PAL, OBF, MEW, PAR, PAF, TEF, TWM, SFA, SCR, SSP, PRE, JTG, DRI, BLK, WHT, MEG, PFL, samt Sword &amp; Shield og Sun &amp; Moon (fx BRS, CRZ, EVS, CEC) og de gamle sæt: BS, JU, FO, B2, TR, LC, GH, GC, N1-N4.</p>
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
      for (const f of found) {
        const c = decorate(f.card, l.set.id), key = c.id + "|" + f.variant, cur = items.get(key);
        items.set(key, { card: c, variant: f.variant, qty: (cur?.qty || 0) + f.qty });
      }
      if (missing.length) problems.push(`${l.set.name}: findes ikke: ${missing.join(", ")}`);
      if (l.bad.length) problems.push(`${l.line}: forstod ikke: ${l.bad.join(", ")}`);
      if (!l.refs.length && !l.bad.length) problems.push(`${l.line}: ingen kortnumre`);
    }
    const ids = [...new Set([...items.values()].map(it => it.card.id))];
    const existing = Object.fromEntries((await fetchIn(() => sb.from("collection").select("card_id,qty,variant").eq("user_id", S.me.id), ids)).map(r => [r.card_id + "|" + r.variant, r.qty]));
    if (token !== S.token) return;
    parsed = { items: [...items.values()].sort((a, b) => cmpCard(a.card, b.card) || a.variant.localeCompare(b.variant)), problems, existing };
    show();
  }
  function show() {
    const { items, problems, existing } = parsed;
    const key = it => it.card.id + "|" + it.variant;
    const newQty = it => Math.min(999, mode === "add" ? (existing[key(it)] || 0) + it.qty : it.qty);
    const copies = items.reduce((s, it) => s + it.qty, 0);
    $("#add-result").innerHTML = `
      ${problems.length ? `<div class="panel problems"><p class="label">Tjek disse</p><ul>${problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      ${items.length ? `<div class="panel stack">
        <div class="hrow"><b>${items.length} kort fundet${copies !== items.length ? ` (${copies} styk)` : ""}</b><span class="grow"></span>
          <button class="btn primary" id="add-commit">Gem i min samling</button></div>
        <ul class="addlist">${items.map(it => { const had = existing[key(it)] || 0, nq = newQty(it);
          return `<li>${it.card.image ? `<img src="${esc(imgUrl(it.card))}" alt="" loading="lazy">` : "<span></span>"}
            <span><span class="n">${esc(it.card.name)}${it.variant !== "normal" ? ` <span class="vtag v-${it.variant}">${VSHORT[it.variant]}</span>` : ""}</span><br><span class="s">${esc(it.card._setName)} · ${esc(it.card.localId)}</span></span>
            <span class="q">${had ? `${had} → ` : ""}<b>${nq}</b></span></li>`; }).join("")}</ul>
      </div>` : (problems.length ? "" : `<p class="empty">Skriv noget i feltet først.</p>`)}`;
    const btn = $("#add-commit");
    if (btn) btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "Gemmer…";
      const payload = items.map(it => ({ user_id: S.me.id, card_id: it.card.id, variant: it.variant, qty: newQty(it) }));
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
    <form class="panel hrow" id="poke-form" autocomplete="off">
      <label for="poke-q" class="sr">Pokémon</label>
      <div class="combo">
        <input type="text" id="poke-q" placeholder="Skriv en Pokémon, fx Charizard, Umbreon eller Pikachu" required
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="poke-list" autocapitalize="words" spellcheck="false">
        <ul class="combo-list" id="poke-list" role="listbox" hidden></ul>
      </div>
      <button class="btn primary" type="submit">Vis alle kort</button>
    </form>
    <p class="hint">Et masterset er alle engelske kort med Pokémonen i navnet på tværs af alle sæt, fx også Charizard ex, Dark Charizard og tag team-kort. Kort, du allerede har registreret i et sæt, tæller automatisk med.</p>
    <div style="height:14px"></div>
    <p class="label">Mine mastersets</p>
    ${tracked?.length ? `<ul class="setlist">${tracked.map(t => `<li><a href="#/pokemon/${encodeURIComponent(t.name)}" data-master="${esc(t.name)}">
      <span class="mono-badge">${esc(t.name.slice(0, 2))}</span><span><span class="n">${esc(t.name)}</span><br><span class="s">Henter kort…</span></span><span class="v"></span>
      <span class="progress"><i style="width:0%"></i></span></a></li>`).join("")}</ul>` : `<p class="empty">Du har ikke gemt nogen mastersets endnu. Søg en Pokémon frem og tryk "Gem som masterset".</p>`}`;
  wireSuggest($("#poke-q"), $("#poke-list"), name => { location.hash = "#/pokemon/" + encodeURIComponent(name); });
  $("#poke-form").onsubmit = async e => {
    e.preventDefault();
    const { canonical } = await import("./suggest.js");
    const raw = $("#poke-q").value, n = canonical(raw) || pokeName(raw);
    if (n) location.hash = "#/pokemon/" + encodeURIComponent(n);
  };
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

// Forslag mens man skriver: piletaster, Enter og klik vælger. Navnelisten hentes først, når feltet bruges.
function wireSuggest(input, list, onPick) {
  let items = [], active = -1, mod = null;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
  const paint = () => {
    list.replaceChildren(...items.map((s, i) => {
      const li = document.createElement("li");
      li.id = "sug-" + i; li.setAttribute("role", "option"); li.setAttribute("aria-selected", i === active);
      const n = document.createElement("span"); n.className = "n"; n.textContent = s.name;
      const m = document.createElement("span"); m.className = "m"; m.textContent = (s.via ? s.via + " · " : "") + "#" + String(s.dex).padStart(4, "0");
      li.append(n, m);
      li.onpointerdown = e => { e.preventDefault(); input.value = s.name; close(); onPick(s.name); };
      return li;
    }));
    list.hidden = !items.length; input.setAttribute("aria-expanded", String(!!items.length));
    if (active >= 0) { input.setAttribute("aria-activedescendant", "sug-" + active); list.children[active]?.scrollIntoView({ block: "nearest" }); }
  };
  input.addEventListener("input", async () => {
    mod ||= await import("./suggest.js");
    items = input.value.trim() ? mod.suggest(input.value, 8) : []; active = items.length ? 0 : -1; paint();
  });
  input.addEventListener("keydown", e => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); const s = items[active]; input.value = s.name; close(); onPick(s.name); }
    else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
}

async function renderPokemon(rawName, username) {
  const token = S.token;
  const sug = await import("./suggest.js");
  const name = sug.canonical(rawName) || pokeName(rawName);
  if (name !== rawName && sug.canonical(rawName)) { location.replace("#/pokemon/" + encodeURIComponent(name) + (username ? "/" + encodeURIComponent(username) : "")); return; }
  const user = await userByName(username);
  if (!user) { $("#app").innerHTML = `<p class="empty">Brugeren findes ikke.</p>`; return; }
  const mine = user.id === S.me.id;
  $("#app").innerHTML = `<p class="empty">Finder alle ${esc(name)}-kort…</p>`;
  const cards = await getPokemonCards(name);
  if (token !== S.token) return;
  if (!cards.length) {
    $("#app").innerHTML = `<div class="pagehead"><h1>${esc(name)}</h1></div><div class="panel"><p class="empty" style="margin:0">Fandt ingen engelske kort med "${esc(name)}" i navnet. ${(() => { const alt = sug.suggest(name, 5).filter(s => s.name !== name);
      return alt.length ? `Mente du ${alt.map(s => `<a href="#/pokemon/${encodeURIComponent(s.name)}">${esc(s.name)}</a>`).join(", ")}?` : `<a href="#/pokemon">Prøv igen</a>`; })()}</p></div>`;
    return;
  }
  const [rows, trackedRes] = await Promise.all([
    fetchIn(() => sb.from("collection").select("card_id,qty,variant").eq("user_id", user.id), cards.map(c => c.id)),
    sb.from("tracked_pokemon").select("name").eq("user_id", S.me.id).eq("name", name).maybeSingle(),
  ]);
  if (token !== S.token) return;
  const owned = toOwned(rows);
  let tracked = !!trackedRes.data;
  const nSets = new Set(cards.map(c => c._setId)).size;
  const trackBtn = () => `<button class="btn${tracked ? "" : " primary"}" id="track">${tracked ? "Fjern fra mine mastersets" : "Gem som masterset"}</button>`;
  renderGrid({
    user, mine, cards, owned, context: "pokemon",
    head: `
      ${mine ? "" : `<div class="viewing">Du ser <b>${esc(user.username)}</b>s ${esc(name)}-kort. <a href="#/pokemon/${encodeURIComponent(name)}">Se dine egne</a></div>`}
      <div class="pagehead">
        <div><h1>${esc(name)} masterset</h1><div class="meta">${cards.length} engelske kort fra ${nSets} sæt</div></div>
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
    fetchAll(() => sb.from("collection").select("card_id,qty,variant").eq("user_id", user.id).eq("set_id", setId)).then(toOwned),
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

// ---------------- prisgrafer i kortvisningen ----------------
const SERIES = [
  { key: "normal", name: "Normal", col: "trend", color: "var(--s1)" },
  { key: "reverse", name: "Reverse", col: "trend_holo", color: "var(--s2)" },
];
const RANGES = [["30", "30 dage"], ["90", "90 dage"], ["365", "1 år"], ["all", "Alt"]];
const dayFmt = d => d.toLocaleDateString("da-DK", { day: "numeric", month: "short" });
const conv = eur => (S.currency === "DKK" ? eur * DKK_RATE : eur);
const niceTicks = (lo, hi, n = 4) => {
  if (hi <= lo) { const p = Math.max(0.01, Math.abs(hi) * 0.1); lo -= p; hi += p; }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => raw <= s);
  const a = Math.floor(lo / step) * step, ticks = [];
  for (let v = a; ; v += step) { ticks.push(+v.toFixed(6)); if (v >= hi - step * 1e-6 || ticks.length > 12) break; }
  return ticks;
};
const axisFmt = v => new Intl.NumberFormat("da-DK", { maximumFractionDigits: v < 10 ? 2 : 0 }).format(v);

// Tegner prishistorik (linjer) eller, hvis historikken er for kort, Cardmarkets gennemsnit (søjler)
function renderPriceChart(el, { history, cm, reverse, range, tracked, onRange }) {
  const series = SERIES.filter(s => s.key === "normal" || reverse).map(s => ({
    ...s, pts: history.map(h => ({ d: new Date(h.day + "T12:00:00"), v: +h[s.col] })).filter(p => p.v > 0),
  })).filter(s => s.pts.length);
  const days = history.length;
  const since = days ? new Date(history[0].day + "T12:00:00").toLocaleDateString("da-DK", { day: "numeric", month: "long", year: "numeric" }) : null;

  // --- stat-linje: nuværende pris og ændring mod 30-dages snittet
  const now = firstPos(cm?.trend, cm?.avg), a30 = firstPos(cm?.avg30);
  const chg = now && a30 ? (now - a30) / a30 * 100 : null;
  const statLine = now ? `<div class="pc-stat"><b>${fmt(now)}</b> <span class="pc-sub">trend nu</span>
    ${chg != null && isFinite(chg) ? `<span class="pc-chg">${chg >= 0 ? "▲" : "▼"} ${Math.abs(chg).toFixed(1).replace(".", ",")} % mod snit 30 dage</span>` : ""}</div>` : "";

  // --- ikke nok historik endnu: søjler med Cardmarkets gennemsnit
  if (series.every(s => s.pts.length < 2)) {
    const bars = [["Snit 30 dage", cm?.avg30], ["Snit 7 dage", cm?.avg7], ["Snit 1 dag", cm?.avg1], ["Trend", cm?.trend]].filter(b => b[1] > 0);
    const max = Math.max(...bars.map(b => b[1]), 0);
    el.innerHTML = `<p class="label">Prisudvikling</p>${statLine}
      ${bars.length ? `<div class="pc-bars" role="img" aria-label="Cardmarket-gennemsnit for normalversionen">${bars.map(([l, v]) => `
        <div class="pc-bar" title="${esc(l)}: ${esc(fmt(v))}"><span class="pc-bl">${l}</span>
          <span class="pc-track"><i style="width:${max ? Math.max(2, v / max * 100) : 0}%"></i></span><span class="pc-bv">${fmt(v)}</span></div>`).join("")}</div>
        <p class="hint">Cardmarkets gennemsnit for normalversionen. Sammenligner du dem, kan du se, om prisen er på vej op eller ned.</p>` : `<p class="empty">Ingen Cardmarket-priser for dette kort.</p>`}
      <p class="hint">${tracked
        ? `Prishistorikken gemmes hver dag${since ? ` siden ${since}` : " fra i dag"}. Grafen over udviklingen dukker op, når der er gået et par dage.`
        : `Prishistorik gemmes for kort, som nogen har i samlingen. Tilføj kortet, så begynder siden at følge prisen fra i dag.`}</p>`;
    return;
  }

  // --- linjegraf
  const cutoff = range === "all" ? 0 : Date.now() - +range * 864e5;
  const vis = series.map(s => ({ ...s, pts: s.pts.filter(p => +p.d >= cutoff) })).filter(s => s.pts.length);
  const allDays = [...new Set(vis.flatMap(s => s.pts.map(p => +p.d)))].sort((a, b) => a - b);
  el.innerHTML = `<p class="label">Prisudvikling</p>${statLine}
    <div class="pc-top">
      <div class="seg pc-range" role="group" aria-label="Periode">${RANGES.map(([k, l]) => `<button data-range="${k}" aria-pressed="${k === range}">${l}</button>`).join("")}</div>
      <span class="grow"></span>
      <span class="pc-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("")}</span>
    </div>
    <div class="pc-wrap" tabindex="0" aria-label="Prisgraf. Brug piletasterne for at se priserne dag for dag.">
      <svg class="pc-svg" role="img" aria-label="Trendpris over tid for ${series.map(s => s.name).join(" og ")}"></svg>
      <div class="pc-tip" hidden></div>
    </div>
    <details class="pc-table"><summary>Vis tallene</summary>
      <div class="tablewrap"><table><thead><tr><th>Dato</th>${series.map(s => `<th class="num">${s.name}</th>`).join("")}</tr></thead>
      <tbody>${history.slice().reverse().map(h => `<tr><td>${new Date(h.day + "T12:00:00").toLocaleDateString("da-DK")}</td>${series.map(s => `<td class="num">${fmt(+h[s.col] > 0 ? +h[s.col] : null)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    </details>
    <p class="hint">Cardmarkets trendpris, gemt én gang om dagen siden ${since}.</p>`;
  el.querySelectorAll("[data-range]").forEach(b => b.onclick = () => onRange(b.dataset.range));
  if (!allDays.length) { el.querySelector(".pc-wrap").innerHTML = `<p class="empty">Ingen priser i den valgte periode.</p>`; return; }

  const wrap = el.querySelector(".pc-wrap"), svg = el.querySelector(".pc-svg"), tip = el.querySelector(".pc-tip");
  const W = Math.max(260, wrap.clientWidth), H = 190, L = 52, R = 14, T = 12, B = 26;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
  const vals = vis.flatMap(s => s.pts.map(p => conv(p.v)));
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const x0 = allDays[0], x1 = allDays[allDays.length - 1] === x0 ? x0 + 864e5 : allDays[allDays.length - 1];
  const X = t => L + (t - x0) / (x1 - x0) * (W - L - R);
  const Y = v => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
  const xt = [x0, x0 + (x1 - x0) / 2, x1];
  let g = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="pc-grid"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" class="pc-ax">${axisFmt(t)}</text>`).join("");
  g += xt.map((t, i) => `<text x="${X(t)}" y="${H - 6}" text-anchor="${["start", "middle", "end"][i]}" class="pc-ax">${dayFmt(new Date(t))}</text>`).join("");
  for (const s of vis) {
    const d = s.pts.map((p, i) => `${i ? "L" : "M"}${X(+p.d).toFixed(1)},${Y(conv(p.v)).toFixed(1)}`).join("");
    const last = s.pts[s.pts.length - 1];
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(+last.d)}" cy="${Y(conv(last.v))}" r="4" fill="${s.color}" stroke="var(--panel)" stroke-width="2"/>`;
  }
  g += `<line class="pc-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <g class="pc-dots"></g><rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" class="pc-hit"/>`;
  svg.innerHTML = g;

  const cross = svg.querySelector(".pc-cross"), dots = svg.querySelector(".pc-dots");
  let idx = -1;
  const show = i => {
    idx = Math.max(0, Math.min(allDays.length - 1, i));
    const t = allDays[idx], x = X(t);
    cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
    tip.hidden = false; tip.replaceChildren();
    const head = document.createElement("div"); head.className = "pc-td"; head.textContent = new Date(t).toLocaleDateString("da-DK", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
    tip.appendChild(head);
    dots.innerHTML = "";
    for (const s of vis) {
      const p = s.pts.find(p => +p.d === t);
      const row = document.createElement("div"); row.className = "pc-tr";
      const key = document.createElement("i"); key.style.background = s.color;
      const v = document.createElement("b"); v.textContent = p ? fmt(p.v) : "–";
      const n = document.createElement("span"); n.textContent = s.name;
      row.append(key, v, n); tip.appendChild(row);
      if (p) dots.insertAdjacentHTML("beforeend", `<circle cx="${x}" cy="${Y(conv(p.v))}" r="4.5" fill="${s.color}" stroke="var(--panel)" stroke-width="2"/>`);
    }
    const tw = tip.offsetWidth, left = x / W * wrap.clientWidth;
    tip.style.left = Math.min(wrap.clientWidth - tw - 4, Math.max(4, left + 12 + tw > wrap.clientWidth ? left - tw - 12 : left + 12)) + "px";
  };
  const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; dots.innerHTML = ""; };
  const nearest = clientX => {
    const r = svg.getBoundingClientRect(), px = (clientX - r.left) / r.width * W;
    let best = 0, bd = Infinity; allDays.forEach((t, i) => { const d = Math.abs(X(t) - px); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const hit = svg.querySelector(".pc-hit");
  hit.addEventListener("pointermove", e => show(nearest(e.clientX)));
  hit.addEventListener("pointerdown", e => show(nearest(e.clientX)));
  hit.addEventListener("pointerleave", hide);
  wrap.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); show(idx < 0 ? allDays.length - 1 : idx + (e.key === "ArrowRight" ? 1 : -1)); }
    if (e.key === "Escape") hide();
  });
  wrap.addEventListener("focus", () => show(allDays.length - 1));
  wrap.addEventListener("blur", hide);
}

// ---------------- fælles perm (bruges af sæt og mastersets) ----------------
// owned: { card_id: { normal: n, reverse: m } }. Hvert kort har en normal-plads og, hvis kortet
// findes i reverse og "Med reverse" er slået til, en reverse-plads.
function renderGrid({ user, mine, cards, owned, context, head, onReady, officialCount }) {
  const token = S.token, G = S.grid, multi = context === "pokemon";
  const q = (id, v) => owned[id]?.[v] || 0;
  const slots = id => variantsOf(id).filter(v => v === "normal" || G.vs[v]);
  const missingSlots = id => slots(id).filter(v => !q(id, v));
  const ownedAny = id => slots(id).some(v => q(id, v));
  $("#app").innerHTML = `${head}
    <div class="stats" id="g-stats"></div>
    <div class="controls">
      <div class="seg" role="group" aria-label="Visning">
        <button data-view="binder" aria-pressed="${G.view === "binder"}">Perm</button>
        <button data-view="list" aria-pressed="${G.view === "list"}">Mangler-liste</button>
        <button data-view="plan" aria-pressed="${G.view === "plan"}">Permeplan</button>
      </div>
      <div class="seg" role="group" aria-label="Filter">
        <button data-filter="all" aria-pressed="${G.filter === "all"}">Alle</button>
        <button data-filter="missing" aria-pressed="${G.filter === "missing"}">Mangler</button>
        <button data-filter="owned" aria-pressed="${G.filter === "owned"}">Har</button>
      </div>
      <div class="seg" role="group" aria-label="Versioner der tælles med">
        ${["reverse", "firstEdition", "shadowless"].map(v => `<button data-vt="${v}" aria-pressed="${!!G.vs[v]}">${VLABEL[v]}</button>`).join("")}
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
    let own = 0, total = 0, ownVal = 0, missVal = 0, missNo = 0;
    const per = {};
    for (const c of cards) for (const v of slots(c.id)) {
      const p = cardPrice(c.id, v), n = q(c.id, v), pv = (per[v] ||= [0, 0]);
      total++; pv[1]++;
      if (n) { own++; pv[0]++; if (p) ownVal += p * n; }
      else if (p) missVal += p; else missNo++;
    }
    const extra = VORDER.filter(v => v !== "normal" && per[v]).map(v => `${VLABEL[v].toLowerCase()} ${per[v][0]}/${per[v][1]}`).join(", ");
    const pct = total ? Math.round(own / total * 100) : 0;
    const known = cards.filter(c => S.prices[c.id]?.variants !== undefined).length;
    $("#g-stats").innerHTML = `
      <div class="stat"><small>${mine ? "Samlet" : esc(user.username) + " har"}${extra ? ` · heraf ${extra}` : ""}</small><b>${own} / ${total}</b><div class="progress"><i style="width:${pct}%"></i></div></div>
      <div class="stat"><small>Værdi</small><b>${fmt(ownVal)}</b></div>
      <div class="stat missing"><small>Pris for de ${total - own} manglende${missNo ? ` (${missNo} uden pris)` : ""}</small><b>${fmt(missVal)}</b></div>
      ${known < cards.length ? `<p class="hint" style="grid-column:1/-1;margin:0">Tjekker hvilke versioner kortene findes i… ${known}/${cards.length}</p>` : ""}`;
  };
  const sortVal = (c, sort) => { const ps = (sort === "list" ? [c._v] : slots(c.id)).map(v => cardPrice(c.id, v)).filter(Boolean); return ps.length ? Math.max(...ps) : null; };
  const sortList = (list, sort, keyFn) => {
    if (sort === "num") list.sort((a, b) => cmpCard(a, b) || String(a._v || "").localeCompare(String(b._v || "")));
    else if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name) || cmpCard(a, b));
    else list.sort((a, b) => { const x = keyFn(a), y = keyFn(b);
      if (x == null && y == null) return cmpCard(a, b); if (x == null) return 1; if (y == null) return -1;
      return sort === "price-asc" ? x - y : y - x; });
    return list;
  };
  const search = list => { const s = G.q.toLowerCase(); return !s ? list : list.filter(c => c.name.toLowerCase().includes(s) || String(c.localId).toLowerCase() === s || (multi && c._setName.toLowerCase().includes(s))); };

  // ---- permeplan: hvilket kort i hvilken lomme
  const PLAN = { per: 9, spread: true, right: true, ...store.get("kp-plan", {}) };
  const GRIDS = { 4: [2, 2], 9: [3, 3], 12: [3, 4], 16: [4, 4] };
  const renderPlan = el => {
    const [cols, rows] = GRIDS[PLAN.per] || GRIDS[9];
    // alle kort i nummerrækkefølge (sæt i udgivelsesrækkefølge), én lomme pr. version
    const pockets = cards.slice().sort(cmpCard).flatMap(c => slots(c.id).map(v => ({ c, v })));
    const pages = [];
    for (let i = 0; i < pockets.length; i += PLAN.per) pages.push(pockets.slice(i, i + PLAN.per));
    const owned = pockets.filter(p => q(p.c.id, p.v)).length;
    const firstGap = pockets.findIndex(p => !q(p.c.id, p.v));
    const where = i => `side ${Math.floor(i / PLAN.per) + 1}, lomme ${i % PLAN.per + 1}`;
    const pageHtml = (pg, n) => `<section class="plan-page" style="--cols:${cols}">
        <header><b>Side ${n + 1}</b><span>${pg.filter(p => q(p.c.id, p.v)).length}/${pg.length}</span></header>
        <div class="plan-grid">${Array.from({ length: PLAN.per }, (_, k) => {
          const p = pg[k]; if (!p) return `<div class="plan-slot empty-slot"></div>`;
          const has = q(p.c.id, p.v) > 0, img = imgUrl(p.c);
          return `<button class="plan-slot${has ? " has" : ""}" data-pid="${esc(p.c.id)}" title="${esc(p.c.name)} · ${esc(p.c._setName)} ${esc(p.c.localId)} · ${VLABEL[p.v]}${has ? "" : " (mangler)"}">
            ${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : ""}
            <span class="plan-lbl">${multi ? `<small>${esc(p.c._setName)}</small>` : ""}<b>${esc(p.c.localId)}</b>${p.v !== "normal" ? ` <span class="vtag v-${p.v}">${VSHORT[p.v]}</span>` : ""}${has ? "" : `<br>${esc(p.c.name)}`}</span>
          </button>`; }).join("")}</div></section>`;
    // opslag: første side alene til højre, hvis permen starter på en højreside
    const spreads = [];
    if (PLAN.spread) {
      let i = 0;
      if (PLAN.right && pages.length) { spreads.push([null, 0]); i = 1; }
      for (; i < pages.length; i += 2) spreads.push([i, i + 1 < pages.length ? i + 1 : null]);
    }
    el.innerHTML = `
      <div class="plan-bar hrow">
        <label>Lommer pr. side <select id="plan-per">${Object.keys(GRIDS).map(k => `<option value="${k}"${+k === PLAN.per ? " selected" : ""}>${k} (${GRIDS[k][0]}×${GRIDS[k][1]})</option>`).join("")}</select></label>
        <label class="chk"><input type="checkbox" id="plan-spread"${PLAN.spread ? " checked" : ""}> Vis som opslag</label>
        <label class="chk"><input type="checkbox" id="plan-right"${PLAN.right ? " checked" : ""}${PLAN.spread ? "" : " disabled"}> Første side er en højreside</label>
        <span class="grow"></span>
        <button class="btn small" id="plan-print">Print tjekliste</button>
      </div>
      <p class="plan-sum">${pockets.length} lommer på ${pages.length} ${pages.length === 1 ? "side" : "sider"}${PLAN.spread ? ` (${spreads.length} opslag)` : ""} · ${owned} fyldt, ${pockets.length - owned} tomme${firstGap >= 0 ? ` · første tomme lomme: ${where(firstGap)}` : ""}</p>
      <div class="plan-pages">${PLAN.spread
        ? spreads.map(([a, b]) => `<div class="plan-spread">${a == null ? `<div class="plan-page blank"></div>` : pageHtml(pages[a], a)}${b == null ? `<div class="plan-page blank"></div>` : pageHtml(pages[b], b)}</div>`).join("")
        : pages.map((pg, n) => pageHtml(pg, n)).join("")}</div>
      <p class="hint">Rækkefølgen følger ${multi ? "sættenes udgivelse og kortnumrene" : "kortnumrene"}, med en lomme pr. version (${slotsLabel()}). Vælg versioner med knapperne ovenfor. Tryk på en lomme for at se kortet.</p>`;
    const save = () => { store.set("kp-plan", PLAN); content(); };
    $("#plan-per").onchange = e => { PLAN.per = +e.target.value; save(); };
    $("#plan-spread").onchange = e => { PLAN.spread = e.target.checked; save(); };
    $("#plan-right").onchange = e => { PLAN.right = e.target.checked; save(); };
    $("#plan-print").onclick = () => window.print();
    el.querySelectorAll("[data-pid]").forEach(b => b.onclick = () => detail(b.dataset.pid));
  };
  const slotsLabel = () => ["normal", ...["firstEdition", "shadowless", "reverse"].filter(v => G.vs[v])].map(v => VLABEL[v].toLowerCase()).join(", ");

  const content = () => {
    const el = $("#g-content"); if (!el) return;
    document.body.classList.toggle("printing-plan", G.view === "plan");
    if (G.view === "plan") return renderPlan(el);
    if (G.view === "list") {
      // én række pr. manglende version
      const list = sortList(search(cards).flatMap(c => missingSlots(c.id).map(v => ({ ...c, _v: v }))),
        G.sort === "num" ? "price-desc" : G.sort, c => cardPrice(c.id, c._v));
      let sum = 0, noP = 0;
      const rows = list.map(c => { const p = cardPrice(c.id, c._v); if (p) sum += p; else noP++; const cm = S.prices[c.id]?.cm;
        const rev = c._v === "reverse", other = c._v !== "normal";
        return `<tr><td>${c.image ? `<img class="thumb" loading="lazy" src="${esc(imgUrl(c))}" alt="">` : ""}</td>
          ${multi ? `<td>${esc(c._setName)}</td>` : ""}<td class="num">${esc(c.localId)}</td><td>${esc(c.name)}${other ? ` <span class="vtag v-${c._v}">${VSHORT[c._v]}</span>` : ""}</td><td>${esc(S.prices[c.id]?.rarity || "")}</td>
          <td class="num">${fmt(NO_PRICE.has(c._v) ? null : rev ? cm?.["low-holo"] : firstPos(cm?.low, cm?.["low-holo"]))}</td><td class="num"><b>${fmt(p)}</b></td>
          <td class="num">${fmt(NO_PRICE.has(c._v) ? null : rev ? cm?.["avg30-holo"] : firstPos(cm?.avg30, cm?.["avg30-holo"]))}</td>
          <td><a href="${esc(cmFor(c, c._v))}" target="_blank" rel="noopener">Cardmarket ↗</a></td>
          ${mine ? `<td><button class="btn small" data-have="${esc(c.id)}" data-v="${c._v}">Har den</button></td>` : ""}</tr>`; }).join("");
      const cols = 8 + (multi ? 1 : 0) + (mine ? 1 : 0);
      el.innerHTML = list.length ? `<div class="tablewrap"><table>
        <thead><tr><th></th>${multi ? "<th>Sæt</th>" : ""}<th class="num">Nr.</th><th>Kort</th><th>Sjældenhed</th><th class="num">Laveste</th><th class="num">Trend</th><th class="num">Snit 30 d.</th><th></th>${mine ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="${multi ? 3 : 2}"></td><td colspan="3">${list.length} mangler${noP ? ` · ${noP} uden pris` : ""}</td><td class="num">${fmt(sum)}</td><td colspan="${cols - (multi ? 3 : 2) - 4}"></td></tr></tfoot>
        </table></div>
        <p class="hint"><span class="vtag v-reverse">R</span> reverse holo · <span class="vtag v-firstEdition">1.</span> 1. udgave · <span class="vtag v-shadowless">S</span> shadowless. 1. udgave og shadowless har ingen separat pris i Cardmarkets prisguide.</p>` : `<p class="empty">Du har dem alle. Flot!</p>`;
      return;
    }
    let list = search(cards);
    if (G.filter === "missing") list = list.filter(c => missingSlots(c.id).length);
    else if (G.filter === "owned") list = list.filter(c => ownedAny(c.id));
    list = sortList(list.slice(), G.sort, c => sortVal(c));
    if (!list.length) { el.innerHTML = `<p class="empty">Ingen kort matcher filteret.</p>`; return; }
    el.innerHTML = `<div class="binder">${list.map(c => {
      const sl = slots(c.id), have = sl.filter(v => q(c.id, v)).length, img = imgUrl(c);
      const state = have === sl.length ? " owned" : have ? " partial" : "";
      const line = v => { const n = q(c.id, v), p = cardPrice(c.id, v);
        return `<div class="vrow${n ? " has" : ""}" data-v="${v}">
          <span class="vl">${sl.length > 1 ? VSHORT[v] : ""}</span>
          <span class="pr${p == null ? " none" : ""}">${p == null ? (NO_PRICE.has(v) ? "–" : S.prices[c.id] ? "ingen pris" : "…") : fmt(p)}</span>
          ${mine ? `<span class="qty">${n ? `<button data-act="dec" aria-label="Færre ${VLABEL[v]}">−</button><span>${n}</span>` : ""}<button data-act="inc" aria-label="Tilføj ${VLABEL[v]}">+</button></span>`
                 : `<span class="qty"><span>${n ? "✓" + (n > 1 ? " ×" + n : "") : "–"}</span></span>`}
        </div>`; };
      return `<div class="pocket${state}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)} ${esc(c.localId)}">
        <div class="img">${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : `<span class="noimg">Intet billede</span>`}</div>
        ${multi ? `<div class="setline">${esc(c._setName)}</div>` : ""}
        <div class="row"><span class="nm">${esc(c.name)}</span><span class="no">${esc(c.localId)}</span></div>
        ${sl.map(line).join("")}
      </div>`; }).join("")}</div>
      <p class="hint">${mine ? "Tryk + og − for at registrere dine kort." : ""} N = normal (unlimited/holo), R = reverse holo, 1. = 1. udgave, S = shadowless. Grøn kant = alle versioner, gul = nogle. Vælg øverst, hvilke versioner der tæller med. Klik på et kort for detaljer og Cardmarket-link.</p>`;
  };
  const all = () => { stats(); content(); };

  async function setQty(id, v, n) {
    n = Math.max(0, Math.min(999, n));
    const before = q(id, v);
    (owned[id] ||= {})[v] = n; if (!n) delete owned[id][v];
    all();
    const res = await saveQty(id, v, n);
    if (res.error) { if (before) owned[id][v] = before; else delete owned[id][v]; all(); setStatus("Kunne ikke gemme: " + res.error.message, true); }
    else scheduleSnapshot();
  }
  function detail(id) {
    const c = cards.find(x => x.id === id); if (!c) return;
    const dlg = $("#dlg");
    let hist = null, fixOpen = false;
    const paintChart = () => {
      const el = dlg.querySelector("#dlg-chart"); if (!el || !hist) return;
      renderPriceChart(el, { history: hist, cm: S.prices[id]?.cm, reverse: hasReverse(id), range: S.chartRange,
        tracked: hist.length > 0 || VORDER.some(v => q(id, v)),
        onRange: r => { S.chartRange = r; store.set("kp-range", r); paintChart(); } });
    };
    const draw = () => {
      const cm = S.prices[id]?.cm || {}, vars = S.prices[id]?.variants;
      const row = (l, k) => (typeof cm[k] === "number" && cm[k] > 0 ? `<dt>${l}</dt><dd>${fmt(cm[k])}</dd>` : "");
      const rows = row("Trend", "trend") + row("Laveste", "low") + row("Snit 7 dage", "avg7") + row("Snit 30 dage", "avg30") +
        row("Reverse: trend", "trend-holo") + row("Reverse: laveste", "low-holo") + row("Reverse: snit 30 d.", "avg30-holo");
      const off = context === "set" ? officialCount : S.setsById[c._setId]?.cardCount?.official;
      const vs = variantsOf(id);
      const exists = S.prices[id] ? vs.map(v => v === "normal" ? (vars?.holo && !vars?.normal ? "holo" : setIdOf(id) === "base1" ? "unlimited" : "normal") : VLABEL[v].toLowerCase()).join(", ") : "";
      const own = vs.filter(v => NO_PRICE.has(v) && cardPrice(id, v)).map(v => `<dt>${VLABEL[v]}: trend</dt><dd>${fmt(cardPrice(id, v))}</dd>`).join("");
      dlg.innerHTML = `<button class="close" aria-label="Luk">×</button><div class="dlg">
        ${c.image ? `<img src="${esc(imgUrl(c, "high"))}" alt="${esc(c.name)}">` : "<div></div>"}
        <div><h3>${esc(c.name)}</h3>
          <div class="meta">${esc(c._setName)} · ${esc(c.localId)}/${off ?? "?"}${S.prices[id]?.rarity ? " · " + esc(S.prices[id].rarity) : ""}${exists ? `<br>Findes som: ${esc(exists)}` : ""}</div>
          <dl class="pl">${rows + own || "<dt>Ingen Cardmarket-pris for dette kort</dt><dd></dd>"}</dl>
          ${mine ? `<div class="vctl">${vs.map(v => `<div class="hrow"><span class="vname">${VLABEL[v]}</span><span class="grow"></span>
              <button class="btn small" data-dv="${v}" data-dq="-1" ${q(id, v) ? "" : "disabled"} aria-label="Fjern en ${VLABEL[v]}">−</button>
              <b class="vcount">${q(id, v)}</b>
              <button class="btn small primary" data-dv="${v}" data-dq="1" aria-label="Tilføj en ${VLABEL[v]}">+</button></div>`).join("")}</div>`
                 : `<p class="meta">${vs.map(v => `${VLABEL[v]}: ${q(id, v) ? "har " + q(id, v) : "mangler"}`).join(" · ")}</p>`}
          <div class="acts">
            <a class="btn" href="${esc(cmFor(c))}" target="_blank" rel="noopener">Se kortet på Cardmarket ↗</a>
            <a class="btn" href="${esc(cmSearch(c.name))}" target="_blank" rel="noopener">Søg i alle sæt ↗</a>
            ${multi ? `<a class="btn" href="#/saet/${encodeURIComponent(c._setId)}">Åbn sættet</a>` : ""}
          </div>
          <p class="hint">Priser: Cardmarkets prisguide via TCGdex, alle sprog samlet. Linket viser engelske kort.</p>
          <details class="vfix"${fixOpen ? " open" : ""}><summary>Er versionerne forkerte?</summary>
            <p class="hint">Oplysningerne kommer fra TCGdex og har huller. Retter du dem her, gælder rettelsen for alle på siden.</p>
            ${["reverse", "firstEdition", "shadowless"].map(v => { const has = vs.includes(v), ov = S.overrides[id]?.[v];
              return `<div class="hrow"><span class="vname">${VLABEL[v]}</span><span class="grow"></span>
                ${ov !== undefined ? `<button class="linkbtn" data-ovreset="${v}">Nulstil</button>` : ""}
                <div class="seg"><button data-ov="${v}" data-val="1" aria-pressed="${has}">Findes</button><button data-ov="${v}" data-val="0" aria-pressed="${!has}">Findes ikke</button></div></div>`; }).join("")}
          </details></div></div>
        <div class="dlg-chart" id="dlg-chart"><p class="label">Prisudvikling</p><p class="empty">Henter prishistorik…</p></div>`;
      dlg.querySelector(".vfix").ontoggle = e => { fixOpen = e.target.open; };
      paintChart();
    };
    draw();
    sb.from("price_history").select("day,trend,low,avg30,trend_holo,low_holo,avg30_holo").eq("card_id", id).order("day")
      .then(({ data }) => { hist = data || []; paintChart(); });
    dlg.onclick = async e => {
      if (e.target === dlg || e.target.closest(".close")) return dlg.close();
      if (e.target.closest("a[href^='#']")) return dlg.close();
      const ovb = e.target.closest("[data-ov],[data-ovreset]");
      if (ovb) {
        fixOpen = true;
        const v = ovb.dataset.ov || ovb.dataset.ovreset, reset = !!ovb.dataset.ovreset, present = ovb.dataset.val === "1";
        const res = reset
          ? await sb.from("variant_overrides").delete().eq("card_id", id).eq("variant", v)
          : await sb.from("variant_overrides").upsert({ card_id: id, variant: v, present, user_id: S.me.id, updated_at: new Date().toISOString() });
        if (res.error) { setStatus("Kunne ikke gemme rettelsen: " + res.error.message, true); return; }
        if (reset) delete S.overrides[id]?.[v]; else (S.overrides[id] ||= {})[v] = present;
        draw(); all(); return;
      }
      const b = e.target.closest("[data-dq]"); if (b) { const v = b.dataset.dv; await setQty(id, v, q(id, v) + +b.dataset.dq); draw(); }
    };
    dlg.showModal();
  }

  const press = (sel, attr, val) => document.querySelectorAll(sel).forEach(x => x.setAttribute("aria-pressed", x.getAttribute(attr) === val));
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { G.view = b.dataset.view; press("[data-view]", "data-view", G.view); content(); });
  document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { G.filter = b.dataset.filter; press("[data-filter]", "data-filter", G.filter); content(); });
  document.querySelectorAll("[data-vt]").forEach(b => b.onclick = () => { const v = b.dataset.vt; G.vs[v] = !G.vs[v]; store.set("kp-vs", G.vs); b.setAttribute("aria-pressed", G.vs[v]); all(); });
  $("#g-sort").onchange = e => { G.sort = e.target.value; content(); };
  $("#g-q").oninput = e => { G.q = e.target.value.trim(); content(); };
  $("#g-content").onclick = e => {
    const have = e.target.closest("[data-have]"); if (have) return setQty(have.dataset.have, have.dataset.v || "normal", 1);
    const pocket = e.target.closest(".pocket"); if (!pocket) return;
    const id = pocket.dataset.id, act = e.target.closest("[data-act]")?.dataset.act, v = e.target.closest("[data-v]")?.dataset.v || "normal";
    if (act === "inc") return setQty(id, v, q(id, v) + 1);
    if (act === "dec") return setQty(id, v, q(id, v) - 1);
    detail(id);
  };
  $("#g-content").onkeydown = e => { const p = e.target.closest?.(".pocket");
    if (p && e.target === p && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); detail(p.dataset.id); } };
  const refresh = async force => {
    $("#g-refresh").disabled = true;
    const r = await loadPrices(cards, force, (d, t) => { setStatus(`Henter priser og varianter… ${d}/${t}`); all(); });
    if (token !== S.token) return;
    $("#g-refresh").disabled = false; all();
    setStatus(r.failed ? `${r.failed} kort kunne ikke hentes. Tryk "Opdatér priser" for at prøve igen.` : "", !!r.failed);
  };
  $("#g-refresh").onclick = () => refresh(true);
  onReady?.();
  all();
  fetchIn(() => sb.from("variant_overrides").select("card_id,variant,present"), cards.map(c => c.id)).then(rows => {
    for (const r of rows) (S.overrides[r.card_id] ||= {})[r.variant] = r.present;
    if (token === S.token && rows.length) all();
  }).catch(() => {});
  refresh(false);
}

// ---------------- app (PWA) ----------------
let deferredInstall = null;
async function promptInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null; $("#install").hidden = true;
  if (route().page === "konto") render();
}
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; $("#install").hidden = false; });
window.addEventListener("appinstalled", () => { deferredInstall = null; $("#install").hidden = true; });
$("#install").onclick = promptInstall;
window.addEventListener("offline", () => setStatus("Du er offline. Ændringer kan ikke gemmes, før du er online igen.", true));
window.addEventListener("online", () => { setStatus(""); render(); });

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
