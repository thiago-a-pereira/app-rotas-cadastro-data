// Gera goiania_geocode_v1.json.gz: indice bairro -> quadra -> lote -> [lat, lng]
// raspando atributos do portalmapa (bairros 313, quadras 312, lotes 311).
// x_coord/y_coord vem em EPSG:31982 (SIRGAS 2000 / UTM 22S) -> converte p/ WGS84.
const fs = require('fs');
const zlib = require('zlib');

const BASE = 'https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer/Mapa_Basico3/MapServer';

// Inversa de Transverse Mercator (GRS80/SIRGAS2000), zona 22S (lon0=-51).
function utmToLatLng(x, y) {
  const a = 6378137.0, f = 1 / 298.257222101;
  const k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const xm = x - 500000.0, ym = y - 10000000.0;
  const M = ym / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
    + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu)
    + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1), tan1 = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const T1 = tan1 * tan1;
  const C1 = ep2 * cos1 * cos1;
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * sin1 * sin1, 1.5);
  const D = xm / (N1 * k0);
  const lat = phi1 - (N1 * tan1 / R1) * (
    D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720
  );
  const lng = (-51 * Math.PI / 180) + (
    D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120
  ) / cos1;
  return [lat * 180 / Math.PI, lng * 180 / Math.PI];
}

async function fetchJson(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.error) throw new Error('arcgis ' + JSON.stringify(json.error.code));
      return json;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

async function fetchAll(layer, outFields) {
  const out = [];
  let offset = 0;
  for (;;) {
    const url = `${BASE}/${layer}/query?where=1%3D1&outFields=${outFields}&returnGeometry=false&resultOffset=${offset}&f=json`;
    const json = await fetchJson(url);
    const feats = (json.features || []).map(f => f.attributes);
    out.push(...feats);
    offset += feats.length;
    if (!json.exceededTransferLimit || feats.length === 0) break;
    if (out.length % 50000 < 1000) console.log(`layer ${layer}: ${out.length}...`);
  }
  return out;
}

(async () => {
  console.log('bairros...');
  const bairrosRaw = await fetchAll(313, 'id,nm_bai');
  console.log('bairros:', bairrosRaw.length);
  console.log('quadras...');
  const quadrasRaw = await fetchAll(312, 'id,id_bai,nm_qdr');
  console.log('quadras:', quadrasRaw.length);
  console.log('lotes...');
  const lotesRaw = await fetchAll(311, 'id_qdr,nm_lot,x_coord,y_coord');
  console.log('lotes:', lotesRaw.length);

  const bairroById = new Map(bairrosRaw.filter(b => b.id && b.nm_bai).map(b => [b.id, b.nm_bai.trim()]));
  const quadraById = new Map();
  for (const q of quadrasRaw) {
    if (!q.id || !q.id_bai || !q.nm_qdr) continue;
    quadraById.set(q.id, { bairro: bairroById.get(q.id_bai), nome: String(q.nm_qdr).trim() });
  }

  const bairros = new Map();
  let indexed = 0, skipped = 0;
  for (const l of lotesRaw) {
    const q = l.id_qdr ? quadraById.get(l.id_qdr) : null;
    const nome = (l.nm_lot == null ? '' : String(l.nm_lot)).trim();
    if (!q || !q.bairro || !nome || !isFinite(l.x_coord) || !isFinite(l.y_coord) || !l.x_coord) { skipped++; continue; }
    const [lat, lng] = utmToLatLng(l.x_coord, l.y_coord);
    if (!bairros.has(q.bairro)) bairros.set(q.bairro, new Map());
    const qmap = bairros.get(q.bairro);
    if (!qmap.has(q.nome)) qmap.set(q.nome, new Map());
    qmap.get(q.nome).set(nome, [Number(lat.toFixed(6)), Number(lng.toFixed(6))]);
    indexed++;
  }
  console.log('indexados:', indexed, 'pulados:', skipped, 'bairros:', bairros.size);

  const out = {
    version: 1,
    city: 'Goiânia',
    uf: 'GO',
    source: 'portalmapa.goiania.go.gov.br Mapa_Basico3 (raspado ' + '2026-06-11' + ')',
    bairros: [...bairros.entries()].map(([n, qmap]) => ({
      n,
      q: Object.fromEntries([...qmap.entries()].map(([q, lmap]) => [q, Object.fromEntries(lmap)])),
    })),
  };
  const json = JSON.stringify(out);
  fs.writeFileSync('C:/Users/Thiago/ap_geocode/goiania_geocode_v1.json', json);
  fs.writeFileSync('C:/Users/Thiago/ap_geocode/goiania_geocode_v1.json.gz', zlib.gzipSync(json, { level: 9 }));
  console.log('json bytes:', json.length, 'gz bytes:', fs.statSync('C:/Users/Thiago/ap_geocode/goiania_geocode_v1.json.gz').size);

  // Validacao: Jardim America Q 12 Lt 5 deve cair perto de -16.6941, -49.2876
  const ja = out.bairros.find(b => b.n === 'Jardim América');
  console.log('amostra Jardim América Q12 L5:', JSON.stringify(ja && ja.q['12'] && ja.q['12']['5']));
})();
