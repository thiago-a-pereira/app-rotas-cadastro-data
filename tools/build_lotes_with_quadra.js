// Gera <cidade>_lotes_v2.json.gz: o bundle de LOTES v1 (cell-indexed {n, g})
// com o numero da QUADRA embutido em cada lote (campo "q"), via JOIN ESPACIAL
// contra o bundle de QUADRAS v1 (centroide do lote dentro do poligono da quadra).
//
// Entrada: os proprios Releases v1 ja publicados (sem dependencia do portal):
//   v1-goiania/goiania_quadras_v1.json.gz   + v1-goiania/goiania_lotes_v1.json.gz
//   v1-aparecida/aparecida_quadras_v1.json.gz + v1-aparecida/aparecida_lotes_v1.json.gz
// Saida: <cidade>_lotes_v2.json.gz no diretorio atual (mesma estrutura do v1,
//   apenas adicionando "q" em cada lote e version=2).
//
// Geometrias dos dois bundles estao em Web Mercator esferico (EPSG:3857), entao
// o ponto-em-poligono roda direto nas coordenadas projetadas, sem reprojetar.
//
// Uso: node tools/build_lotes_with_quadra.js
const fs = require('fs');
const zlib = require('zlib');

const RELEASE_BASE =
  'https://github.com/thiago-a-pereira/app-rotas-cadastro-data/releases/download';
const CITIES = [
  {
    label: 'Goiânia',
    quadras: `${RELEASE_BASE}/v1-goiania/goiania_quadras_v1.json.gz`,
    lotes: `${RELEASE_BASE}/v1-goiania/goiania_lotes_v1.json.gz`,
    out: 'goiania_lotes_v2.json.gz',
  },
  {
    label: 'Aparecida de Goiânia',
    quadras: `${RELEASE_BASE}/v1-aparecida/aparecida_quadras_v1.json.gz`,
    lotes: `${RELEASE_BASE}/v1-aparecida/aparecida_lotes_v1.json.gz`,
    out: 'aparecida_lotes_v2.json.gz',
  },
];

// Grade do indice espacial das quadras (metros, Web Mercator).
const GRID_CELL = 300;
// Lote cujo centroide caia FORA de qualquer quadra (borda/concavidade): adota a
// quadra de centroide mais proximo ate este raio, senao fica sem "q".
const FALLBACK_RADIUS = 80;

async function fetchGz(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

// Centroide (area-ponderado) de um anel; cai para a media dos vertices quando a
// area e degenerada.
function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sy = 0;
    for (const [x, y] of ring) { sx += x; sy += y; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

// Ponto-em-poligono por regra par/impar somando TODOS os aneis da quadra
// (trata buracos e multipart corretamente: dentro de qualquer parte solida =
// numero impar de cruzamentos).
function inRings(px, py, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > py) !== (yj > py)) &&
          (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
  }
  return inside;
}

const cellKey = (cx, cy) => `${cx}:${cy}`;

function buildQuadraIndex(quadras) {
  const grid = new Map();
  const meta = [];
  quadras.forEach((f, idx) => {
    const rings = f.g && f.g.rings;
    if (!rings || !rings.length) return;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
    }
    const [cx, cy] = centroid(rings[0]);
    meta[idx] = {
      q: (f.q == null ? '' : String(f.q)).trim(),
      rings, minx, miny, maxx, maxy, cx, cy,
    };
    const gx0 = Math.floor(minx / GRID_CELL), gx1 = Math.floor(maxx / GRID_CELL);
    const gy0 = Math.floor(miny / GRID_CELL), gy1 = Math.floor(maxy / GRID_CELL);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = cellKey(gx, gy);
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(idx);
      }
    }
  });
  return { grid, meta };
}

function quadraFor(px, py, grid, meta) {
  const gx = Math.floor(px / GRID_CELL), gy = Math.floor(py / GRID_CELL);
  let best = null, bestArea = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = grid.get(cellKey(gx + dx, gy + dy));
      if (!arr) continue;
      for (const idx of arr) {
        const m = meta[idx];
        if (px < m.minx || px > m.maxx || py < m.miny || py > m.maxy) continue;
        if (inRings(px, py, m.rings)) {
          const area = (m.maxx - m.minx) * (m.maxy - m.miny);
          if (area < bestArea) { bestArea = area; best = m; } // mais especifica
        }
      }
    }
  }
  if (best) return best.q;
  let near = null, nd = FALLBACK_RADIUS * FALLBACK_RADIUS;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = grid.get(cellKey(gx + dx, gy + dy));
      if (!arr) continue;
      for (const idx of arr) {
        const m = meta[idx];
        const d = (m.cx - px) ** 2 + (m.cy - py) ** 2;
        if (d < nd) { nd = d; near = m; }
      }
    }
  }
  return near ? near.q : null;
}

async function buildCity(city) {
  console.log(`\n[${city.label}] baixando v1...`);
  const [quadrasDoc, lotesDoc] = await Promise.all([
    fetchGz(city.quadras),
    fetchGz(city.lotes),
  ]);
  const { grid, meta } = buildQuadraIndex(quadrasDoc.features);
  let total = 0, withQuadra = 0;
  const distinct = new Set();
  const samples = [];
  for (const key of Object.keys(lotesDoc.cells)) {
    for (const lote of lotesDoc.cells[key]) {
      total++;
      const rings = lote.g && lote.g.rings;
      if (!rings || !rings.length) continue;
      const [px, py] = centroid(rings[0]);
      const q = quadraFor(px, py, grid, meta);
      if (q != null && q !== '') {
        lote.q = q;
        withQuadra++;
        distinct.add(q);
        if (samples.length < 8) samples.push({ n: lote.n, q });
      }
    }
  }
  lotesDoc.version = 2;
  lotesDoc.quadraJoin = {
    source: city.quadras.split('/').pop(),
    gridCell: GRID_CELL,
    fallbackRadius: FALLBACK_RADIUS,
  };
  const json = JSON.stringify(lotesDoc);
  fs.writeFileSync(city.out, zlib.gzipSync(json, { level: 9 }));
  const pct = ((100 * withQuadra) / total).toFixed(1);
  console.log(
    `[${city.label}] quadras=${quadrasDoc.features.length} lotes=${total} ` +
    `comQuadra=${withQuadra} (${pct}%) quadrasDistintas=${distinct.size}`,
  );
  console.log(`[${city.label}] amostras:`, JSON.stringify(samples));
  console.log(`[${city.label}] ${city.out} (${fs.statSync(city.out).size} bytes)`);
}

(async () => {
  for (const city of CITIES) await buildCity(city);
  console.log('\nOK. Publique como assets dos Releases v2-goiania / v2-aparecida.');
})();
