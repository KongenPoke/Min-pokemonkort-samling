// Forslag til Pokémon-navne med tolerance for stavefejl.
// Rækkefølge: præcist match, starter med, indeholder, og til sidst tæt på (1-2 bogstaver forkert).
import { POKEMON, ALIAS } from "./names.js";

export const norm = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9♀♂]/g, "");
const IDX = POKEMON.map((name, i) => {
  const aliases = ALIAS[i] ? ALIAS[i].split("|") : [];
  return { name, dex: i + 1, keys: [name, ...aliases].map(norm), aliases };
});

// Damerau-Levenshtein med loft, så den er hurtig
function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}

export function suggest(query, limit = 8) {
  const q = norm(query);
  if (!q) return [];
  const max = q.length <= 3 ? 0 : q.length <= 5 ? 1 : 2;
  const out = [];
  for (const e of IDX) {
    let score = Infinity, via = null;
    e.keys.forEach((k, i) => {
      let s;
      if (k === q) s = 0;
      else if (k.startsWith(q)) s = 1 + (k.length - q.length) / 100;
      else if (q.length >= 3 && k.includes(q)) s = 2;
      else if (max) {
        // stavefejl: sammenlign med hele navnet og med starten af navnet
        const d = Math.min(dist(q, k, max), dist(q, k.slice(0, q.length), max));
        if (d <= max) s = 3 + d;
      }
      if (s !== undefined && i > 0) s += 0.5;   // engelske navne går forud for tyske/franske
      if (s !== undefined && s < score) { score = s; via = i === 0 ? null : e.aliases[i - 1]; }
    });
    if (score < Infinity) out.push({ name: e.name, dex: e.dex, via, score });
  }
  return out.sort((a, b) => a.score - b.score || a.dex - b.dex).slice(0, limit);
}

// Det engelske navn, hvis teksten præcist matcher et navn eller alias (fx "glurak" -> "Charizard")
export function canonical(text) {
  const q = norm(text);
  const e = IDX.find(x => x.keys.includes(q));
  return e ? e.name : null;
}
