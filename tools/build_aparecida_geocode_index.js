// Gera aparecida_geocode_v1.json.gz: indice bairro -> quadra -> lote -> [lat, lng]
// a partir do shapefile de lotes da AddressForAll (EPSG:4326).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = fs.readdirSync('C:/Users/Thiago/ap_geocode/parcel').map(d => path.join('C:/Users/Thiago/ap_geocode/parcel', d))[0];
const base = fs.readdirSync(dir).find(f => f.endsWith('.shp')).replace(/\.shp$/, '');
const shp = fs.readFileSync(path.join(dir, base + '.shp'));
const dbf = fs.readFileSync(path.join(dir, base + '.dbf'));

// --- DBF (latin1) ---
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
    out[f.name] = dbf.toString('latin1', pos, pos + f.len).trim();
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
console.log('indexados:', indexed, 'pulados:', skipped, 'bairros:', bairros.size);

const out = {
  version: 1,
  city: 'Aparecida de Goiânia',
  uf: 'GO',
  source: 'AddressForAll pk0084 (dados municipais ~2020)',
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
