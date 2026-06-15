// Gera aparecida_geocode_v1.json.gz: indice bairro -> quadra -> lote -> [lat, lng]
// a partir do shapefile de lotes da AddressForAll (EPSG:4326).
//
// ENCODING: o DBF da AddressForAll esta em UTF-8. A primeira versao lia como
// latin1 e gravava mojibake ("VL BrasÃ­lia"), quebrando o casamento de bairro
// (Vila Brasília e o bairro de maior volume). Agora le como UTF-8.
//
// U+FFFD: alem do mojibake, ~25k registros da FONTE municipal ja vem com o
// replacement char (bytes EF BF BD) no lugar de uma vogal acentuada
// ("VL Bras<U+FFFD>lia"). Como o app dobra o nome (tira acentos/pontuacao) para
// comparar, o U+FFFD sumiria e "braslia" nao casaria com "brasilia". Duas
// passadas reconstroem esses nomes a partir do proprio dataset:
//   1) irmao limpo unico: o nome inteiro, com cada U+FFFD como curinga, casa
//      uma unica chave dobrada limpa -> adota o nome limpo (acentuado).
//   2) por token: cada token com U+FFFD tem as vogais-base testadas contra o
//      vocabulario de tokens limpos ("Bras?lia"->"Brasília", "Ac?cias"->
//      "Acácias", "Ant?nio"->"Antônio").
// Os nomes sem reconstrucao possivel (bairros de nicho, sem irmao no dataset)
// permanecem com U+FFFD.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = fs.readdirSync('C:/Users/Thiago/ap_geocode/parcel').map(d => path.join('C:/Users/Thiago/ap_geocode/parcel', d))[0];
const base = fs.readdirSync(dir).find(f => f.endsWith('.shp')).replace(/\.shp$/, '');
const shp = fs.readFileSync(path.join(dir, base + '.shp'));
const dbf = fs.readFileSync(path.join(dir, base + '.dbf'));

// --- DBF (UTF-8) ---
const recordCount = dbf.readUInt32LE(4);
const headerSize = dbf.readUInt16LE(8);
const recordSize = dbf.readUInt16LE(10);
const fields = [];
for (let off = 32; off < headerSize - 1; off += 32) {
  const name = dbf.toString('ascii', off, off + 11).replace(/\0.*$/, '');
  if (!name) break;
  fields.push({ name, len: dbf[off + 16] });
}
function attrs(i) {
  let pos = headerSize + i * recordSize + 1;
  const out = {};
  for (const f of fields) {
    out[f.name] = dbf.toString('utf8', pos, pos + f.len).replace(/\0+$/, '').trim();
    pos += f.len;
  }
  return out;
}

// --- SHP: centroide (media de todos os pontos) por registro ---
const centroids = [];
let pos = 100;
while (pos < shp.length) {
  const contentLen = shp.readUInt32BE(pos + 4) * 2;
  const shapeType = shp.readInt32LE(pos + 8);
  if (shapeType === 5) {
    const numParts = shp.readInt32LE(pos + 44);
    const numPoints = shp.readInt32LE(pos + 48);
    const pointsStart = pos + 52 + numParts * 4;
    let sx = 0, sy = 0;
    for (let p = 0; p < numPoints; p++) {
      sx += shp.readDoubleLE(pointsStart + p * 16);
      sy += shp.readDoubleLE(pointsStart + p * 16 + 8);
    }
    centroids.push([sy / numPoints, sx / numPoints]); // [lat, lng]
  } else {
    centroids.push(null);
  }
  pos += 8 + contentLen;
}
console.log('shp records:', centroids.length, 'dbf records:', recordCount);

// --- Indice ---
const SUP_RE = /^Q\.?\s*([0-9A-Za-z\-\/ ]+?)\s*,\s*LT\.?\s*(.+)$/i;
const bairros = new Map(); // nome original -> Map(quadra -> Map(lote -> [lat,lng]))
let indexed = 0, skipped = 0;
for (let i = 0; i < recordCount; i++) {
  const c = centroids[i];
  const a = attrs(i);
  const m = SUP_RE.exec(a.sup || '');
  const bairro = (a.nsvia || '').trim();
  if (!c || !m || !bairro) { skipped++; continue; }
  const quadra = m[1].trim();
  const lote = m[2].trim();
  if (!bairros.has(bairro)) bairros.set(bairro, new Map());
  const qmap = bairros.get(bairro);
  if (!qmap.has(quadra)) qmap.set(quadra, new Map());
  qmap.get(quadra).set(lote, [Number(c[0].toFixed(6)), Number(c[1].toFixed(6))]);
  indexed++;
}

// --- Reconstrucao de U+FFFD ---
const FFFD = '�';
function fold(s) {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(new RegExp('[^a-z0-9 ' + FFFD + ']', 'g'), ' ')
    .replace(/\s+/g, ' ').trim();
}
const names = [...bairros.keys()];
const remap = new Map();

// Passada 1: nome inteiro casa uma unica chave dobrada limpa.
const cleanFolded = names.filter(n => !n.includes(FFFD)).map(n => ({ n, f: fold(n) }));
let recoveredSibling = 0;
for (const n of names) {
  if (!n.includes(FFFD)) continue;
  const folded = fold(n);
  const pat = '^' + [...folded].map(ch => ch === FFFD ? '[a-z]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$';
  let re;
  try { re = new RegExp(pat); } catch (e) { continue; }
  const matches = cleanFolded.filter(c => re.test(c.f));
  const byKey = new Map();
  for (const m of matches) {
    if (!byKey.has(m.f)) byKey.set(m.f, []);
    byKey.get(m.f).push(m.n);
  }
  if (byKey.size === 1) {
    const cands = [...byKey.values()][0];
    const best = cands.find(x => /[^\x00-\x7f]/.test(x)) || cands[0];
    remap.set(n, best);
    recoveredSibling++;
  }
}

// Passada 2: reconstrucao por token contra o vocabulario limpo.
const tokDisplay = new Map();
for (const n of names) {
  if (n.includes(FFFD)) continue;
  for (const w of n.split(/\s+/)) {
    const f = fold(w);
    if (!f) continue;
    if (!tokDisplay.has(f) || /[^\x00-\x7f]/.test(w)) tokDisplay.set(f, w);
  }
}
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'c'];
function reconstructTokens(name) {
  let changed = false;
  const out = name.split(/(\s+)/).map(seg => {
    if (!seg.includes(FFFD)) return seg;
    const f = fold(seg);
    let cands = [f];
    for (let k = 0; k < f.length; k++) {
      if (f[k] === FFFD) {
        const nc = [];
        for (const c of cands) for (const v of VOWELS) nc.push(c.slice(0, k) + v + c.slice(k + 1));
        cands = nc;
      }
    }
    for (const c of cands) {
      if (tokDisplay.has(c)) { changed = true; return tokDisplay.get(c); }
    }
    return seg;
  }).join('');
  return changed && !out.includes(FFFD) ? out : null;
}
let recoveredToken = 0;
for (const n of names) {
  if (!n.includes(FFFD) || remap.has(n)) continue;
  const fixed = reconstructTokens(n);
  if (fixed) { remap.set(n, fixed); recoveredToken++; }
}

// Aplica remap (funde quadras no nome reconstruido).
for (const [bad, good] of remap) {
  const src = bairros.get(bad);
  if (!bairros.has(good)) bairros.set(good, new Map());
  const dst = bairros.get(good);
  for (const [q, lm] of src) {
    if (!dst.has(q)) dst.set(q, new Map());
    for (const [l, c] of lm) dst.get(q).set(l, c);
  }
  bairros.delete(bad);
}
const remainingBad = [...bairros.keys()].filter(n => n.includes(FFFD));
console.log('indexados:', indexed, 'pulados:', skipped, 'bairros:', bairros.size);
console.log('U+FFFD reconstruidos: irmao=' + recoveredSibling, 'token=' + recoveredToken, '| restantes=' + remainingBad.length);

const out = {
  version: 1,
  city: 'Aparecida de Goiânia',
  uf: 'GO',
  source: 'AddressForAll pk0084 (dados municipais ~2020); UTF-8 + reconstrucao U+FFFD',
  bairros: [...bairros.entries()].map(([n, qmap]) => ({
    n,
    q: Object.fromEntries([...qmap.entries()].map(([q, lmap]) => [q, Object.fromEntries(lmap)])),
  })),
};
const json = JSON.stringify(out);
fs.writeFileSync('C:/Users/Thiago/ap_geocode/aparecida_geocode_v1.json', json);
fs.writeFileSync('C:/Users/Thiago/ap_geocode/aparecida_geocode_v1.json.gz', zlib.gzipSync(json, { level: 9 }));
console.log('json bytes:', json.length, 'gz bytes:', fs.statSync('C:/Users/Thiago/ap_geocode/aparecida_geocode_v1.json.gz').size);

// Amostra de validacao
const sample = out.bairros.find(b => b.n.includes('Jardim Luz'));
console.log('amostra Jardim Luz Q 62 LT 9:', JSON.stringify(sample && sample.q['62'] && sample.q['62']['9']));
