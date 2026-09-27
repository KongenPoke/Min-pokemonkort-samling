// Fortolker tekst til hurtig registrering, fx
//   151: 1, 4, 6, 25x2, 199
//   PAL 12-18
//   TG05 GG12x3        (en linje uden sæt bruger sættet fra linjen over)
// Ren logik uden netværk, så den kan testes for sig.

// Engelske sætkoder -> TCGdex-id. Bruges kun, hvis id'et findes i sætlisten.
export const SET_CODES = {
  // Mega Evolution
  MEG: "me01", PFL: "me02",
  // Scarlet & Violet
  SVI: "sv01", PAL: "sv02", OBF: "sv03", MEW: "sv03.5", PAR: "sv04", PAF: "sv04.5", TEF: "sv05",
  TWM: "sv06", SFA: "sv06.5", SCR: "sv07", SSP: "sv08", PRE: "sv08.5", JTG: "sv09", DRI: "sv10",
  BLK: "sv10.5b", WHT: "sv10.5w", SVP: "svp", SVE: "sve",
  // Sword & Shield
  SSH: "swsh1", RCL: "swsh2", DAA: "swsh3", CPA: "swsh3.5", VIV: "swsh4", SHF: "swsh4.5", BST: "swsh5",
  CRE: "swsh6", EVS: "swsh7", CEL: "cel25", FST: "swsh8", BRS: "swsh9", ASR: "swsh10", PGO: "swsh10.5",
  LOR: "swsh11", SIT: "swsh12", CRZ: "swsh12.5", SWSH: "swshp",
  // Sun & Moon
  SUM: "sm1", GRI: "sm2", BUS: "sm3", SLG: "sm3.5", CIN: "sm4", UPR: "sm5", FLI: "sm6", CES: "sm7",
  DRM: "sm7.5", LOT: "sm8", TEU: "sm9", DET: "det1", UNB: "sm10", UNM: "sm11", HIF: "sm115", CEC: "sm12", SMP: "smp",
  // XY
  XY: "xy1", FLF: "xy2", FFI: "xy3", PHF: "xy4", PRC: "xy5", ROS: "xy6", AOR: "xy7", BKT: "xy8", BKP: "xy9",
  GEN: "g1", FCO: "xy10", STS: "xy11", EVO: "xy12",
  // WOTC (1. udgave og shadowless)
  BS: "base1", JU: "base2", FO: "base3", B2: "base4", TR: "base5", LC: "base6",
  GH: "gym1", GC: "gym2", N1: "neo1", N2: "neo2", N3: "neo3", N4: "neo4",
};

// "TG05" og "TG5" er det samme kort; "001" og "1" også
export const normNo = s => String(s).trim().toUpperCase().replace(/^([A-Z]*)0*(\d+)([A-Z]*)$/, "$1$2$3");

// "1, 4, 25x2, 12-18, TG01-TG03, 4r, 25rx2" -> [{ref:"1",qty:1,variant:"normal"}, ...] + ugyldige stykker
// Bogstav efter nummeret: r = reverse holo, e = 1. udgave, s = shadowless, p = Poké Ball, m = Master Ball.
export function expandTokens(rest) {
  const refs = [], bad = [];
  const clean = String(rest).replace(/(\d)\s+([respm])\b/gi, "$1$2").replace(/\s*[x×*]\s*(\d+)\b/gi, "x$1");
  for (let tok of clean.split(/[,;\s]+/).filter(Boolean)) {
    let qty = 1, variant = "normal";
    const q = tok.match(/^(.+?)x(\d+)$/i);
    if (q) { tok = q[1]; qty = Math.max(1, Math.min(99, +q[2])); }
    const rv = tok.match(/^(.*\d)([respm])$/i);
    if (rv) { tok = rv[1]; variant = { r: "reverse", e: "firstEdition", s: "shadowless", p: "pokeball", m: "masterball" }[rv[2].toLowerCase()]; }
    const r = tok.match(/^([A-Za-z]*)(\d+)-([A-Za-z]*)(\d+)$/);
    if (r) {
      const [, p1, a, p2, b] = r, from = +a, to = +b;
      if ((p2 && p2.toUpperCase() !== p1.toUpperCase()) || to < from || to - from > 400) { bad.push(tok); continue; }
      for (let n = from; n <= to; n++) refs.push({ ref: p1 + n, qty, variant });
      continue;
    }
    if (/^[A-Za-z]*\d+[A-Za-z]*$/.test(tok)) refs.push({ ref: tok, qty, variant });
    else bad.push(tok);
  }
  return { refs, bad };
}

// Finder et sæt ud fra id, kode eller navn. strict = kun præcise match (bruges når der ikke er kolon).
export function resolveSet(text, sets, strict) {
  const t = String(text).trim(), low = t.toLowerCase();
  if (!t) return { error: "Mangler sæt" };
  const byId = sets.find(s => s.id.toLowerCase() === low);
  if (byId) return { set: byId };
  const code = SET_CODES[t.toUpperCase()];
  if (code) { const s = sets.find(x => x.id === code); if (s) return { set: s }; }
  const byName = sets.filter(s => s.name.toLowerCase() === low);
  if (byName.length === 1) return { set: byName[0] };
  if (strict) return { error: `Kender ikke sættet "${t}"` };
  const part = sets.filter(s => s.name.toLowerCase().includes(low));
  if (part.length === 1) return { set: part[0] };
  if (part.length > 1) return { error: `"${t}" passer på flere sæt: ${part.slice(0, 4).map(s => s.name).join(", ")}${part.length > 4 ? " …" : ""}` };
  return { error: `Kender ikke sættet "${t}"` };
}

// Deler teksten op i linjer med sæt og kortnumre
export function parseLines(text, sets) {
  const out = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let setPart = null, rest = line;
    const colon = line.indexOf(":");
    if (colon > 0) { setPart = line.slice(0, colon); rest = line.slice(colon + 1); }
    else {
      const words = line.split(/\s+/);
      for (let k = Math.min(words.length, 5); k >= 1; k--) {
        const cand = words.slice(0, k).join(" ");
        if (resolveSet(cand, sets, true).set) { setPart = cand; rest = words.slice(k).join(" "); break; }
      }
      // ellers: ord uden tal i starten af linjen tolkes som (en del af) et sætnavn
      if (setPart === null) {
        let k = 0;
        while (k < words.length && /^[^\d]+$/.test(words[k]) && !/^x\d*$/i.test(words[k])) k++;
        if (k > 0) { setPart = words.slice(0, k).join(" "); rest = words.slice(k).join(" "); }
      }
    }
    let set = current, error = null;
    if (setPart !== null) {
      const r = resolveSet(setPart, sets, false);
      if (r.set) { set = r.set; current = r.set; } else { error = r.error; set = null; }
    } else if (!current) error = "Linjen mangler et sæt, fx \"151: 1, 4, 6\"";
    const { refs, bad } = expandTokens(rest);
    out.push({ line, set, error, refs, bad });
  }
  return out;
}

// Matcher numre mod kortene i et sæt
export function matchRefs(refs, cards) {
  const index = new Map();
  for (const c of cards) { const k = normNo(c.localId); if (!index.has(k)) index.set(k, c); }
  const found = [], missing = [];
  for (const r of refs) { const c = index.get(normNo(r.ref)); if (c) found.push({ card: c, qty: r.qty, variant: r.variant || "normal" }); else missing.push(r.ref); }
  return { found, missing };
}
