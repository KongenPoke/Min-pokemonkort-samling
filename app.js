// Kortpermen – Pokémon-samling med venner. Data: Supabase. Kort og priser: TCGdex (Cardmarket).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

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
  binder: { view: "binder", filter: "all", sort: "num", q: "" },
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
const imgUrl = (c, q = "low") => c?.image ? `${c.image}/${q}.webp` : null;
const cmSlug = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[&'’:.,!?()]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const cmLink = (name, setName) => `https://www.cardmarket.com/en/Pokemon/Products/Singles/${cmSlug(setName)}?searchString=${encodeURIComponent(name)}&language=1`;
const cmSearch = name => `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(name)}&language=1`;
const setIdOf = cardId => cardId.replace(/-[^-]+$/, "");

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
async function getSet(id) {
  let c = store.get("kp-set-" + id, null);
  if (!c || Date.now() - c.t > SET_TTL) {
    try { c = { t: Date.now(), d: await getJSON(`${API}/sets/${encodeURIComponent(id)}`) }; store.set("kp-set-" + id, c); }
    catch (e) { if (!c) throw e; }
  }
  return c.d;
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

// ---------------- routing ----------------
// #/samling[/brugernavn]   #/saet[/sætId[/brugernavn]]   #/venner
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
    if (r.page === "saet") return await renderBinder(r.a, r.b);
    if (r.page === "venner") return await renderFriends();
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
          <p class="msg" id="authmsg"></p>
        </form>
      </section>`;
    document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { mode = b.dataset.mode; draw(); });
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
  const rows = await fetchAll(() => sb.from("collection").select("card_id,qty,set_id").eq("user_id", user.id));
  if (token !== S.token) return;

  // seneste priser fra databasen (fyldes af den natlige/timelige opsamling)
  const ids = rows.map(r => r.card_id), latest = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await sb.from("latest_prices").select("card_id,trend,low,trend_holo,low_holo,day").in("card_id", ids.slice(i, i + 150));
    for (const p of data || []) latest[p.card_id] = p;
  }
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

  // top 5 mest værdifulde
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
      ${mine ? `<a class="btn primary" href="#/saet">Tilføj kort</a>` : ""}</div>
    <div class="stats">
      <div class="stat"><small>Forskellige kort</small><b>${rows.length}</b></div>
      <div class="stat"><small>Kort i alt</small><b>${copies}</b></div>
      <div class="stat"><small>Samlet værdi${noPrice ? ` (${noPrice} uden pris endnu)` : ""}</small><b>${fmt(value)}</b></div>
      <div class="stat"><small>Sæt i gang</small><b>${setIds.length}</b></div>
    </div>
    ${rows.length ? `
    <div class="grid2">
      <section>
        <p class="label">Sæt</p>
        <ul class="setlist">${setIds.map(id => {
          const s = S.setsById[id], total = s?.cardCount?.total || 0, own = bySet[id].own, pct = total ? Math.min(100, own / total * 100) : 0;
          return `<li><a href="#/saet/${encodeURIComponent(id)}${userPart}">
            ${s?.logo ? `<img src="${esc(s.logo)}.webp" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : "<span></span>"}
            <span><span class="n">${esc(s?.name || id)}</span><br><span class="s">${own} af ${total || "?"} kort</span></span>
            <span class="v">${fmt(bySet[id].value)}</span>
            <span class="progress"><i style="width:${pct}%"></i></span></a></li>`;
        }).join("")}</ul>
      </section>
      <section class="panel">
        <p class="label">Mest værdifulde kort</p>
        ${top.length ? `<ul class="topcards">${top.map(t => { const c = names[t.card_id];
          return `<li>${c?.image ? `<img src="${esc(c.image)}/low.webp" alt="" loading="lazy">` : "<span></span>"}
            <span><span class="n">${esc(c?.name || t.card_id)}</span><br><span class="s">${esc(c?.set_name || t.set_id)} · ${esc(c?.local_id || "")}${t.qty > 1 ? " · ×" + t.qty : ""}</span></span>
            <span class="v">${fmt(t.p)}</span></li>`; }).join("")}</ul>` : `<p class="empty">Priserne kommer, når opsamlingen har kørt.</p>`}
        <p class="hint">Værdien bygger på Cardmarkets trendpris${days.length ? `, senest opdateret ${new Date(days[days.length - 1]).toLocaleDateString("da-DK")}` : ""}. Nye kort får pris inden for en time.</p>
      </section>
    </div>` : `<div class="panel"><p class="empty" style="margin:0">${mine ? `Du har ikke registreret nogen kort endnu. <a href="#/saet">Vælg et sæt</a> og tryk + på de kort, du har.` : "Ingen kort registreret endnu."}</p></div>`}`;
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

// ---------------- permen (et sæt) ----------------
async function renderBinder(setId, username) {
  const token = S.token;
  if (!setId) {
    const last = store.get("kp-current", null);
    const pick = (last && S.setsById[last]) ? last : (S.sets.find(s => s.name === "151") || S.sets[S.sets.length - 1])?.id;
    if (pick) { location.replace("#/saet/" + encodeURIComponent(pick)); } else { $("#app").innerHTML = `<p class="empty">Ingen sæt fundet.</p>`; }
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
  const B = S.binder, cards = set.cards || [];
  const userPart = mine ? "" : "/" + encodeURIComponent(user.username);

  const optList = q => S.sets.filter(s => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)).slice().reverse()
    .map(s => `<option value="${esc(s.id)}"${s.id === setId ? " selected" : ""}>${esc(s.name)} (${esc(s.id)})</option>`).join("") || "<option disabled>Ingen sæt matcher</option>";
  const rel = set.releaseDate ? new Date(set.releaseDate).toLocaleDateString("da-DK", { year: "numeric", month: "long" }) : "";
  $("#app").innerHTML = `
    ${mine ? "" : `<div class="viewing">Du ser <b>${esc(user.username)}</b>s perm. <a href="#/saet/${encodeURIComponent(setId)}">Se din egen</a></div>`}
    <div class="setpick">
      <input type="search" id="set-q" placeholder="Søg efter sæt, fx 151 eller Evolving" aria-label="Søg efter sæt">
      <select id="set-sel" aria-label="Vælg sæt">${optList("")}</select>
    </div>
    <div class="pagehead">
      ${set.logo ? `<img src="${esc(set.logo)}.webp" alt="" onerror="this.remove()">` : ""}
      <div><h1>${esc(set.name)}</h1><div class="meta">${esc(set.serie?.name || "")}${rel ? " · " + esc(rel) : ""} · ${set.cardCount?.official ?? "?"} officielle kort + ${Math.max(0, (set.cardCount?.total ?? 0) - (set.cardCount?.official ?? 0))} secret</div></div>
    </div>
    <div class="stats" id="b-stats"></div>
    <div class="controls">
      <div class="seg" role="group" aria-label="Visning">
        <button data-view="binder" aria-pressed="${B.view === "binder"}">Perm</button>
        <button data-view="list" aria-pressed="${B.view === "list"}">Mangler-liste</button>
      </div>
      <div class="seg" role="group" aria-label="Filter">
        <button data-filter="all" aria-pressed="${B.filter === "all"}">Alle</button>
        <button data-filter="missing" aria-pressed="${B.filter === "missing"}">Mangler</button>
        <button data-filter="owned" aria-pressed="${B.filter === "owned"}">Har</button>
      </div>
      <select id="b-sort" aria-label="Sortering">
        <option value="num">Sortér: nummer</option><option value="price-desc">Sortér: dyreste først</option>
        <option value="price-asc">Sortér: billigste først</option><option value="name">Sortér: navn</option>
      </select>
      <input type="search" id="b-q" placeholder="Søg kort i sættet" aria-label="Søg kort" value="${esc(B.q)}">
      <button class="btn" id="b-refresh">Opdatér priser</button>
    </div>
    <div id="b-content"></div>`;
  $("#b-sort").value = B.sort;

  const stats = () => {
    let own = 0, ownVal = 0, miss = 0, missVal = 0, missNo = 0;
    for (const c of cards) { const p = cardPrice(c.id), q = owned[c.id] || 0;
      if (q) { own++; if (p) ownVal += p * q; } else { miss++; if (p) missVal += p; else missNo++; } }
    const pct = cards.length ? Math.round(own / cards.length * 100) : 0;
    $("#b-stats").innerHTML = `
      <div class="stat"><small>${mine ? "Samlet" : esc(user.username) + " har"}</small><b>${own} / ${cards.length}</b><div class="progress"><i style="width:${pct}%"></i></div></div>
      <div class="stat"><small>Værdi</small><b>${fmt(ownVal)}</b></div>
      <div class="stat missing"><small>Pris for de ${miss} manglende${missNo ? ` (${missNo} uden pris)` : ""}</small><b>${fmt(missVal)}</b></div>`;
  };
  const visible = () => {
    let list = cards.slice(); const q = B.q.toLowerCase();
    if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || String(c.localId).toLowerCase() === q);
    if (B.view === "list" || B.filter === "missing") list = list.filter(c => !owned[c.id]);
    else if (B.filter === "owned") list = list.filter(c => owned[c.id]);
    const sort = B.view === "list" && B.sort === "num" ? "price-desc" : B.sort;
    if (sort === "num") list.sort(cmpNum);
    else if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name) || cmpNum(a, b));
    else list.sort((a, b) => { const x = cardPrice(a.id), y = cardPrice(b.id);
      if (x == null && y == null) return cmpNum(a, b); if (x == null) return 1; if (y == null) return -1;
      return sort === "price-asc" ? x - y : y - x; });
    return list;
  };
  const content = () => {
    const el = $("#b-content"); if (!el) return;
    const list = visible();
    if (B.view === "list") {
      let sum = 0, noP = 0;
      const rows = list.map(c => { const p = cardPrice(c.id); if (p) sum += p; else noP++; const cm = S.prices[c.id]?.cm;
        return `<tr><td>${c.image ? `<img class="thumb" loading="lazy" src="${esc(imgUrl(c))}" alt="">` : ""}</td>
          <td class="num">${esc(c.localId)}</td><td>${esc(c.name)}</td><td>${esc(S.prices[c.id]?.rarity || "")}</td>
          <td class="num">${fmt(firstPos(cm?.low, cm?.["low-holo"]))}</td><td class="num"><b>${fmt(p)}</b></td>
          <td class="num">${fmt(firstPos(cm?.avg30, cm?.["avg30-holo"]))}</td>
          <td><a href="${esc(cmLink(c.name, set.name))}" target="_blank" rel="noopener">Cardmarket ↗</a></td>
          ${mine ? `<td><button class="btn small" data-have="${esc(c.id)}">Har den</button></td>` : ""}</tr>`; }).join("");
      el.innerHTML = list.length ? `<div class="tablewrap"><table>
        <thead><tr><th></th><th class="num">Nr.</th><th>Kort</th><th>Sjældenhed</th><th class="num">Laveste</th><th class="num">Trend</th><th class="num">Snit 30 d.</th><th></th>${mine ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td></td><td></td><td colspan="3">${list.length} kort mangler${noP ? ` · ${noP} uden pris` : ""}</td><td class="num">${fmt(sum)}</td><td colspan="${mine ? 3 : 2}"></td></tr></tfoot>
        </table></div>` : `<p class="empty">Hele sættet er samlet. Flot!</p>`;
      return;
    }
    if (!list.length) { el.innerHTML = `<p class="empty">Ingen kort matcher filteret.</p>`; return; }
    el.innerHTML = `<div class="binder">${list.map(c => {
      const q = owned[c.id] || 0, p = cardPrice(c.id), img = imgUrl(c);
      return `<div class="pocket${q ? " owned" : ""}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)} ${esc(c.localId)}${q ? ", har " + q : ""}">
        ${q > 1 ? `<span class="badge">×${q}</span>` : ""}
        <div class="img">${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : `<span class="noimg">Intet billede</span>`}</div>
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
    const res = n
      ? await sb.from("collection").upsert({ user_id: S.me.id, card_id: id, qty: n })
      : await sb.from("collection").delete().eq("user_id", S.me.id).eq("card_id", id);
    if (res.error) {
      if (before) owned[id] = before; else delete owned[id];
      all(); setStatus("Kunne ikke gemme: " + res.error.message, true);
    } else scheduleSnapshot();
  }
  function detail(id) {
    const c = cards.find(x => x.id === id); if (!c) return;
    const dlg = $("#dlg");
    const draw = () => {
      const cm = S.prices[id]?.cm || {}, q = owned[id] || 0;
      const row = (l, k) => (typeof cm[k] === "number" && cm[k] > 0 ? `<dt>${l}</dt><dd>${fmt(cm[k])}</dd>` : "");
      const rows = row("Trend", "trend") + row("Laveste", "low") + row("Snit 7 dage", "avg7") + row("Snit 30 dage", "avg30") +
        row("Trend (holo/reverse)", "trend-holo") + row("Laveste (holo/reverse)", "low-holo") + row("Snit 30 d. (holo/reverse)", "avg30-holo");
      dlg.innerHTML = `<button class="close" aria-label="Luk">×</button><div class="dlg">
        ${c.image ? `<img src="${esc(imgUrl(c, "high"))}" alt="${esc(c.name)}">` : "<div></div>"}
        <div><h3>${esc(c.name)}</h3>
          <div class="meta">${esc(set.name)} · ${esc(c.localId)}/${set.cardCount?.official ?? "?"}${S.prices[id]?.rarity ? " · " + esc(S.prices[id].rarity) : ""}</div>
          <dl class="pl">${rows || "<dt>Ingen Cardmarket-pris for dette kort</dt><dd></dd>"}</dl>
          <div class="acts">
            ${mine ? `<button class="btn primary" data-dq="1">${q ? "Tilføj en mere" : "Jeg har den"}</button>${q ? `<button class="btn" data-dq="-1">Fjern en (${q})</button>` : ""}` : ""}
            <a class="btn" href="${esc(cmLink(c.name, set.name))}" target="_blank" rel="noopener">Se kortet på Cardmarket ↗</a>
            <a class="btn" href="${esc(cmSearch(c.name))}" target="_blank" rel="noopener">Søg i alle sæt ↗</a>
          </div>
          <p class="hint">Priser: Cardmarkets prisguide via TCGdex, alle sprog samlet. Linket viser engelske kort.</p></div></div>`;
    };
    draw();
    dlg.onclick = async e => {
      if (e.target === dlg || e.target.closest(".close")) return dlg.close();
      const b = e.target.closest("[data-dq]"); if (b) { await setQty(id, (owned[id] || 0) + +b.dataset.dq); draw(); }
    };
    dlg.showModal();
  }

  // hændelser
  $("#set-q").oninput = e => { $("#set-sel").innerHTML = optList(e.target.value.trim().toLowerCase()); };
  $("#set-sel").onchange = e => { location.hash = "#/saet/" + encodeURIComponent(e.target.value) + userPart; };
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { B.view = b.dataset.view;
    document.querySelectorAll("[data-view]").forEach(x => x.setAttribute("aria-pressed", x === b)); content(); });
  document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { B.filter = b.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(x => x.setAttribute("aria-pressed", x === b)); content(); });
  $("#b-sort").onchange = e => { B.sort = e.target.value; content(); };
  $("#b-q").oninput = e => { B.q = e.target.value.trim(); content(); };
  $("#b-content").onclick = e => {
    const have = e.target.closest("[data-have]"); if (have) return setQty(have.dataset.have, 1);
    const pocket = e.target.closest(".pocket"); if (!pocket) return;
    const id = pocket.dataset.id, act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "inc") return setQty(id, (owned[id] || 0) + 1);
    if (act === "dec") return setQty(id, (owned[id] || 0) - 1);
    detail(id);
  };
  $("#b-content").onkeydown = e => { const p = e.target.closest?.(".pocket");
    if (p && e.target === p && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); detail(p.dataset.id); } };
  const refresh = async force => {
    $("#b-refresh").disabled = true;
    const r = await loadPrices(cards, force, (d, t) => { setStatus(`Henter priser… ${d}/${t}`); all(); });
    if (token !== S.token) return;
    $("#b-refresh").disabled = false; all();
    setStatus(r.failed ? `${r.failed} kort kunne ikke hentes. Tryk "Opdatér priser" for at prøve igen.` : "", !!r.failed);
  };
  $("#b-refresh").onclick = () => refresh(true);
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
  if (was !== now) { S.me = null; setTimeout(render, 0); }
});
const { data: { session } } = await sb.auth.getSession();
S.session = session;
render();
