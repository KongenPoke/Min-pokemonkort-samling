// Kortscanner: kamera -> tekstgenkendelse (Tesseract, kører på telefonen) -> find kortet -> tilføj.
import { parseOcr, findCandidates } from "./scanmatch.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const CARD_RATIO = 88 / 63;
let workerPromise = null;

function loadScript(src) {
  return new Promise((ok, fail) => {
    if (window.Tesseract) return ok();
    const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => fail(new Error("Kunne ikke hente tekstgenkendelsen"));
    document.head.appendChild(s);
  });
}
function getWorker(onProgress) {
  workerPromise ||= loadScript(TESSERACT).then(() => window.Tesseract.createWorker("eng", 1, {
    logger: m => { if (m.status && typeof m.progress === "number") onProgress?.(m); },
  })).catch(e => { workerPromise = null; throw e; });
  return workerPromise;
}

// Tegner et udsnit af kilden (video eller billede) op i fuld størrelse, gråtoner og mere kontrast
function crop(src, sx, sy, sw, sh, targetW) {
  const scale = Math.max(1, targetW / sw);
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const g = c.getContext("2d", { willReadFrequently: true });
  const native = typeof g.filter === "string";
  if (native) g.filter = "grayscale(1) contrast(1.6) brightness(1.05)";
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  if (!native) {
    const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = Math.max(0, Math.min(255, (y - 128) * 1.6 + 128 + 12));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(img, 0, 0);
  }
  return c;
}

// En tom tegnliste får Tesseract til ikke at genkende noget, så navne læses med en fuld liste
const NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzéÉ0123456789-'.&: ";
// psm 11 (spredt tekst) læser den lille nummerlinje bedst; navn og hele kort læses som tekstblok (psm 6)
async function ocr(worker, canvas, whitelist, psm = "11") {
  await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist || NAME_CHARS });
  const { data } = await worker.recognize(canvas);
  return data.text || "";
}

export function mountScanner(root, ctx) {
  const { esc, fmt, imgUrl, S, sb, getSet, loadPrices, variantsOf, cardPrice, saveQty, scheduleSnapshot, decorate, VLABEL, setStatus } = ctx;
  let stream = null, busy = false, session = [];

  root.innerHTML = `
    <div class="pagehead"><h1>Scan kort</h1><span class="grow"></span><a class="btn" href="#/tilfoej">Skriv numre i stedet</a></div>
    <div class="scan-grid">
      <section class="stack">
        <div class="scan-cam" id="sc-cam">
          <video id="sc-video" playsinline muted></video>
          <div class="scan-frame" id="sc-frame"><span class="scan-hint">Hold kortet inden for rammen</span><span class="scan-num">Nummeret nederst skal kunne læses</span></div>
          <div class="scan-off" id="sc-off" hidden></div>
        </div>
        <div class="hrow">
          <button class="btn primary scan-btn" id="sc-shot">Scan kort</button>
          <label class="btn" for="sc-file">Brug et billede</label>
          <input type="file" id="sc-file" accept="image/*" capture="environment" hidden>
        </div>
        <p class="hint" id="sc-msg">Godt lys og et kort uden genskin giver det bedste resultat. Første scan henter tekstgenkendelsen (ca. 5 MB).</p>
      </section>
      <section class="stack">
        <div id="sc-result"></div>
        <div id="sc-session"></div>
      </section>
    </div>`;
  const $ = s => root.querySelector(s);
  const msg = (t, err) => { $("#sc-msg").textContent = t; $("#sc-msg").classList.toggle("err", !!err); };

  // ---- kamera
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return camOff("Din browser giver ikke adgang til kameraet her. Brug \"Brug et billede\".");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      const v = $("#sc-video"); v.srcObject = stream; await v.play();
    } catch (e) {
      camOff(e.name === "NotAllowedError" ? "Kameraet er blokeret. Giv siden adgang til kameraet i browserens indstillinger, eller brug \"Brug et billede\"." : "Kameraet kunne ikke startes. Brug \"Brug et billede\".");
    }
  }
  function camOff(text) { const o = $("#sc-off"); o.hidden = false; o.textContent = text; $("#sc-shot").disabled = true; }
  function stopCamera() { stream?.getTracks().forEach(t => t.stop()); stream = null; }
  const onLeave = () => { stopCamera(); window.removeEventListener("hashchange", onLeave); document.removeEventListener("visibilitychange", onVis); };
  const onVis = () => { if (document.hidden) stopCamera(); else if (!stream && location.hash.startsWith("#/scan")) startCamera(); };
  window.addEventListener("hashchange", onLeave);
  document.addEventListener("visibilitychange", onVis);
  startCamera();

  // rammens position i videoens egne pixels (videoen vises med object-fit: cover)
  function frameInVideo() {
    const v = $("#sc-video"), cam = $("#sc-cam").getBoundingClientRect(), fr = $("#sc-frame").getBoundingClientRect();
    const vw = v.videoWidth, vh = v.videoHeight, scale = Math.max(cam.width / vw, cam.height / vh);
    const ox = (cam.width - vw * scale) / 2, oy = (cam.height - vh * scale) / 2;
    return { x: (fr.left - cam.left - ox) / scale, y: (fr.top - cam.top - oy) / scale, w: fr.width / scale, h: fr.height / scale };
  }

  // ---- genkendelse
  async function recognize(src, box) {
    if (busy) return; busy = true; $("#sc-shot").disabled = true;
    $("#sc-result").innerHTML = `<div class="panel"><p class="empty" style="margin:0">Læser kortet…</p></div>`;
    try {
      const worker = await getWorker(m => { if (m.status.includes("load") || m.status.includes("initializ")) msg(`Henter tekstgenkendelse… ${Math.round(m.progress * 100)} %`); });
      msg("Læser kortnummeret…");
      const { x, y, w, h } = box;
      // nederste stribe (nummer og sætkode) i høj opløsning, øverste stribe (navn)
      const bottom = crop(src, x, y + h * 0.84, w, h * 0.16, 1600);
      const top = crop(src, x, y, w, h * 0.13, 1400);
      const bText = await ocr(worker, bottom, "0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ");
      msg("Læser navnet…");
      const tText = await ocr(worker, top, "", "6");
      // hvis rammen ikke passede (fx et billede), prøv hele billedet
      let parsed = parseOcr(bText, tText), fullText = tText;
      if (!parsed.numbers.length && !parsed.promos.length) {
        msg("Prøver hele billedet…");
        fullText = await ocr(worker, crop(src, x, y, w, h, 1600), "", "3");
        parsed = parseOcr(fullText, fullText);
      }
      const cands = await findCandidates(parsed, fullText + " " + tText, S.sets, async sid => (await getSet(sid)).cards || []);
      showResult(cands, parsed);
      msg(cands.length ? "Tjek at det er det rigtige kort, og tilføj det." : "Kunne ikke finde kortet. Prøv igen med kortet tættere på og uden genskin.", !cands.length);
    } catch (e) {
      $("#sc-result").innerHTML = ""; msg("Scanningen fejlede: " + e.message, true);
    } finally { busy = false; $("#sc-shot").disabled = !stream; }
  }

  $("#sc-shot").onclick = () => {
    const v = $("#sc-video"); if (!v.videoWidth) return;
    recognize(v, frameInVideo());
  };
  $("#sc-file").onchange = async e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    const img = await createImageBitmap(f).catch(() => null);
    if (!img) return msg("Kunne ikke åbne billedet.", true);
    // gæt et kortformat midt i billedet; ellers bruges hele billedet
    let w = img.width, h = img.height;
    if (h / w > CARD_RATIO) h = w * CARD_RATIO; else w = h / CARD_RATIO;
    recognize(img, { x: (img.width - w) / 2, y: (img.height - h) / 2, w, h });
  };

  // ---- resultat
  function showResult(cands, parsed) {
    const el = $("#sc-result");
    if (!cands.length) {
      const read = parsed.numbers.map(n => `${n.pre}${n.n}/${n.tot}`).concat(parsed.promos.map(p => p.pre + p.n)).join(", ");
      el.innerHTML = `<div class="panel"><p style="margin:0"><b>Intet kort fundet.</b> ${read ? `Jeg læste "${esc(read)}", men fandt ikke et engelsk kort med det nummer.` : "Jeg kunne ikke læse et kortnummer."}</p></div>`;
      return;
    }
    const [best, ...rest] = cands;
    const sure = best.why.length > 0 && (!rest.length || rest[0].score < best.score - 15);
    el.innerHTML = `
      <div class="panel scan-hit">
        <p class="label">${sure ? "Fundet" : "Bedste gæt"}</p>
        <div id="sc-best"></div>
      </div>
      ${rest.length ? `<div class="panel"><p class="label">${sure ? "Eller var det et af disse?" : "Vælg det rigtige kort"}</p>
        <div class="scan-alts">${rest.slice(0, 12).map((c, i) => `<button class="scan-alt" data-i="${i + 1}">
          ${c.card.image ? `<img src="${esc(imgUrl(c.card))}" alt="" loading="lazy">` : ""}<span>${esc(c.card.name)}</span><small>${esc(c.set.name)} · ${esc(c.card.localId)}</small></button>`).join("")}</div></div>` : ""}`;
    el.querySelectorAll(".scan-alt").forEach(b => b.onclick = () => showCard(cands[+b.dataset.i]));
    showCard(best);
  }

  async function showCard(c) {
    const card = decorate(c.card, c.set.id), box = $("#sc-best");
    const paint = owned => {
      const vs = variantsOf(card.id);
      box.innerHTML = `<div class="scan-card">
        ${card.image ? `<img src="${esc(imgUrl(card, "high"))}" alt="${esc(card.name)}">` : "<div></div>"}
        <div class="stack">
          <div><h3>${esc(card.name)}</h3><div class="meta">${esc(card._setName)} · ${esc(card.localId)}/${c.set.cardCount?.official ?? "?"}${c.why.length ? ` · genkendt på ${esc(c.why.join(" og "))}` : ""}</div></div>
          <div class="vctl">${vs.map(v => `<div class="hrow"><span class="vname">${VLABEL[v]}</span>
            <span class="pc-sub">${cardPrice(card.id, v) ? fmt(cardPrice(card.id, v)) : ""}</span><span class="grow"></span>
            <span class="pc-sub">har ${owned[v] || 0}</span>
            <button class="btn small primary" data-add="${v}">+ Tilføj</button></div>`).join("")}</div>
        </div></div>`;
      box.querySelectorAll("[data-add]").forEach(b => b.onclick = async () => {
        const v = b.dataset.add, n = (owned[v] || 0) + 1;
        b.disabled = true;
        const res = await saveQty(card.id, v, n);
        if (res.error) { b.disabled = false; return setStatus("Kunne ikke gemme: " + res.error.message, true); }
        owned[v] = n; scheduleSnapshot();
        session.unshift({ card, v, t: Date.now() }); paintSession();
        paint(owned); msg(`${card.name} (${VLABEL[v].toLowerCase()}) er tilføjet. Klar til næste kort.`);
      });
    };
    box.innerHTML = `<p class="empty">Henter kortets versioner og pris…</p>`;
    const [rows] = await Promise.all([
      sb.from("collection").select("variant,qty").eq("user_id", S.me.id).eq("card_id", card.id).then(r => r.data || []),
      loadPrices([card], false),
    ]);
    paint(Object.fromEntries(rows.map(r => [r.variant, r.qty])));
  }

  function paintSession() {
    $("#sc-session").innerHTML = session.length ? `<div class="panel"><p class="label">Tilføjet i denne omgang (${session.length})</p>
      <ul class="addlist">${session.map((s, i) => `<li>${s.card.image ? `<img src="${esc(imgUrl(s.card))}" alt="">` : "<span></span>"}
        <span><span class="n">${esc(s.card.name)}${s.v !== "normal" ? ` <span class="vtag v-${s.v}">${esc(VLABEL[s.v])}</span>` : ""}</span><br><span class="s">${esc(s.card._setName)} · ${esc(s.card.localId)}</span></span>
        <button class="btn small" data-undo="${i}">Fortryd</button></li>`).join("")}</ul></div>` : "";
    root.querySelectorAll("[data-undo]").forEach(b => b.onclick = async () => {
      const s = session[+b.dataset.undo];
      const { data } = await sb.from("collection").select("qty").eq("user_id", S.me.id).eq("card_id", s.card.id).eq("variant", s.v).maybeSingle();
      const res = await saveQty(s.card.id, s.v, Math.max(0, (data?.qty || 1) - 1));
      if (res.error) return setStatus("Kunne ikke fortryde: " + res.error.message, true);
      session.splice(+b.dataset.undo, 1); paintSession(); msg(`${s.card.name} er fjernet igen.`);
    });
  }
}
