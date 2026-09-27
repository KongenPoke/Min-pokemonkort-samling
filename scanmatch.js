// Tolker OCR-tekst fra et kortbillede og finder kandidater (sæt + kort).
// Kortnummeret står nederst, fx "033/108", "TG05/TG30" eller "SWSH050". Nyere kort har også
// sætkoden (fx "PAL EN"). Navnet øverst bruges til at vælge mellem sæt med samme antal kort.
import { SET_CODES, normNo } from "./parse.js";

const FIX = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };
const fixDigits = s => s.replace(/[OQDILSBZG]/g, c => FIX[c]);
export const normName = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Undersæt med egne numre (Trainer Gallery, Galarian Gallery, Shiny Vault, Radiant Collection)
const SUBSETS = { TG: ["swsh9", "swsh10", "swsh11", "swsh12"], GG: ["swsh12.5"], SV: ["swsh4.5", "sm115"], RC: ["g1", "bw11"] };
const PROMOS = { SWSH: "swshp", SM: "smp", XY: "xyp", BW: "bwp", SVP: "svp" };

export function parseOcr(bottomText, fullText = "") {
  const t = (bottomText + " " + fullText).toUpperCase().replace(/[|\\]/g, "/").replace(/\s+/g, " ");
  const numbers = [], seen = new Set();
  // ingen krav om mellemrum før præfikset: OCR klistrer ofte "G PAL EN 042" sammen til "GPALEN042"
  const re = /([A-Z]{0,4}?)\s?([0-9][0-9OQDILSBZG]{0,2})\s?\/\s?([A-Z]{0,4}?)\s?([0-9][0-9OQDILSBZG]{1,2})(?![0-9])/g;
  for (const m of t.matchAll(re)) {
    // "TGO0S/TG30": bogstaver sidst i præfikset, der ligner tal, hører til nummeret
    let pre = m[1] || "", digits = m[2];
    const tail = pre.match(/[OQDIL]+$/);
    if (tail && (SUBSETS[pre.slice(0, -tail[0].length)] || !pre.slice(0, -tail[0].length))) { digits = tail[0] + digits; pre = pre.slice(0, -tail[0].length); }
    if (!SUBSETS[pre] && SUBSETS[m[3]]) pre = m[3];   // præfikset står også efter skråstregen
    const n = +fixDigits(digits), tot = +fixDigits(m[4]);
    if (!n || !tot || tot < 5) continue;
    const key = pre + n + "/" + tot;
    if (!seen.has(key)) { seen.add(key); numbers.push({ pre, n, tot }); }
  }
  const promos = [];
  for (const m of t.matchAll(/\b(SWSH|SVP|SM|XY|BW)\s?([0-9][0-9OQDILSBZG]{1,2})\b/g)) promos.push({ pre: m[1], n: +fixDigits(m[2]) });
  const words = t.match(/\b[A-Z]{3,4}\b/g) || [];
  const glued = [...t.matchAll(/([A-Z]{3})\s?EN\s?[0-9OQ]/g)].map(x => x[1]);   // "PALEN042" -> PAL
  const codes = [...new Set([...words, ...glued].filter(c => SET_CODES[c] && !["SVP", "SWSH"].includes(c)))];
  return { numbers, promos, codes };
}

// sets: fysiske engelske sæt (med cardCount), cardsOf(setId) -> Promise<cards[]>
export async function findCandidates(parsed, nameText, sets, cardsOf) {
  const byId = Object.fromEntries(sets.map(s => [s.id, s]));
  const nameN = normName(nameText);
  const want = new Map();   // setId -> [ref, ...]
  const add = (sid, ref) => { if (byId[sid]) (want.get(sid) || want.set(sid, []).get(sid)).push(ref); };
  const codeSets = parsed.codes.map(c => SET_CODES[c]).filter(id => byId[id]);

  for (const { pre, n, tot } of parsed.numbers) {
    if (pre && SUBSETS[pre]) { SUBSETS[pre].forEach(sid => add(sid, pre + n)); continue; }
    for (const s of sets) if (s.cardCount?.official === tot) add(s.id, String(n));
    codeSets.forEach(sid => add(sid, String(n)));   // sætkoden vinder, også hvis totalen er læst forkert
  }
  for (const { pre, n } of parsed.promos) add(PROMOS[pre], pre + String(n).padStart(pre === "SVP" ? 3 : 2, "0"));

  const out = [];
  await Promise.all([...want].map(async ([sid, refs]) => {
    let cards; try { cards = await cardsOf(sid); } catch { return; }
    const idx = new Map(cards.map(c => [normNo(c.localId), c]));
    for (const ref of new Set(refs)) {
      const card = idx.get(normNo(ref)); if (!card) continue;
      const cn = normName(card.name), base = normName(card.name.split(/[ -]/)[0]);
      let score = 10, why = [];
      if (codeSets.includes(sid)) { score += 50; why.push("sætkode"); }
      if (nameN && (nameN.includes(cn) || (base.length >= 4 && nameN.includes(base)))) { score += 30; why.push("navn"); }
      score += (byId[sid].order ?? 0) / 10000;   // nyere sæt en anelse foran ved lighed
      out.push({ set: byId[sid], card, score, why });
    }
  }));
  const uniq = new Map();
  for (const c of out) if (!uniq.has(c.card.id) || uniq.get(c.card.id).score < c.score) uniq.set(c.card.id, c);
  return [...uniq.values()].sort((a, b) => b.score - a.score);
}
