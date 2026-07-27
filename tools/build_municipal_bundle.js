// Gera bundles de quadras/lotes (mesmo formato v1 dos presets locais: ver
// README.md) para um município a partir dos dados brutos publicados pela
// AddressForAll/digital-guard em https://github.com/digital-guard/preserv-BR.
//
// Achado (2026-07-27): cada município tem uma pasta data/{UF}/{Cidade}/_pk{donor}.{pack}
// com um make_conf.yaml listando os arquivos brutos (nome = sha256, baixável
// direto em https://dl.digital-guard.org/{sha256}.zip) e o srid de origem no
// próprio GeoJSON (campo crs.properties.name). Não há padrão fixo de nomes de
// propriedade por município (cada prefeitura digitalizou do seu jeito) — por
// isso o field de rótulo do lote/quadra é passado explicitamente na config,
// depois de inspecionar uma amostra do GeoJSON bruto.
//
// Uso:
//   node tools/build_municipal_bundle.js configs/bage.json
//
// A config tem o formato:
// {
//   "citySlug": "bage",        // usado no nome dos arquivos de saída
//   "cityLabel": "Bagé/RS",    // valor do campo "city" no bundle
//   "uf": "RS", "cityFolder": "Bage",  // data/{uf}/{cityFolder} no preserv-BR
//   "packFolder": "_pk0082.01",         // opcional; se omitido, autodetecta (1a pasta)
//   "quarteirao": { "zipFileIndex": 3, "geojsonName": "QUARTEIRAO", "labelField": "baiqd" },
//   "lote": { "zipFileIndex": 2, "geojsonName": "LOTES_URBANOS", "labelField": "numero" }
// }
// (zipFileIndex é o `file:` do layers.block/layers.parcel no make_conf.yaml —
// 1-based, corresponde à ordem em `files:`.)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const proj4 = require('proj4');

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const proj4DefCache = new Map();

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);
  return res.text();
}

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function findPackFolder(uf, cityFolder) {
  const listing = await fetchJson(
    `https://api.github.com/repos/digital-guard/preserv-BR/contents/data/${uf}/${cityFolder}`,
  );
  const dirs = listing.filter((e) => e.type === 'dir');
  if (dirs.length === 0) throw new Error(`Nenhuma pasta de pack em data/${uf}/${cityFolder}`);
  if (dirs.length > 1) {
    console.warn(
      `[aviso] ${uf}/${cityFolder} tem ${dirs.length} packs (${dirs.map((d) => d.name).join(', ')}); usando a 1a. Verifique make_conf.yaml das outras se faltar layer.`,
    );
  }
  return dirs[0].name;
}

// Parser mínimo do make_conf.yaml (estrutura fixa e simples: não é YAML geral).
function parseMakeConf(yamlText) {
  const files = [];
  const fileBlockRe = /-\s*file:\s*(\S+)[\s\S]*?(?=\n-\s*file:|\nlicense_evidences:|\nlayers:|$)/g;
  let m;
  while ((m = fileBlockRe.exec(yamlText))) {
    const block = m[0];
    const file = m[1];
    const name = /name:\s*(.+)/.exec(block)?.[1]?.trim();
    const p = /p:\s*(\d+)/.exec(block)?.[1];
    files.push({ file, name, p: p ? Number(p) : null });
  }
  return { files, raw: yamlText };
}

function findFileForIndex(parsed, index) {
  const found = parsed.files.find((f) => f.p === index);
  if (!found) {
    throw new Error(
      `Nenhum arquivo com p=${index} em make_conf.yaml (arquivos: ${JSON.stringify(parsed.files)})`,
    );
  }
  return found;
}

async function proj4StringForEpsg(epsgCode) {
  if (epsgCode === 4326 || epsgCode === 4674 || epsgCode === 'CRS84') {
    return 'EPSG:4326';
  }
  if (proj4DefCache.has(epsgCode)) return proj4DefCache.get(epsgCode);
  const def = await fetchText(`https://epsg.io/${epsgCode}.proj4`);
  const trimmed = def.trim();
  proj4.defs(`EPSG:${epsgCode}`, trimmed);
  proj4DefCache.set(epsgCode, `EPSG:${epsgCode}`);
  return `EPSG:${epsgCode}`;
}

function epsgFromCrsName(crsName) {
  // "urn:ogc:def:crs:EPSG::31981" ou "urn:ogc:def:crs:OGC:1.3:CRS84"
  if (!crsName) return 4326;
  if (crsName.includes('CRS84')) return 4326;
  const m = /EPSG::?(\d+)/.exec(crsName);
  if (m) return Number(m[1]);
  throw new Error(`CRS não reconhecido: ${crsName}`);
}

const WEBMERCATOR =
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs';

function ringsFromGeometry(geometry, transform) {
  const polys =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : null;
  if (!polys) return null;
  const rings = [];
  for (const poly of polys) {
    for (const ring of poly) {
      rings.push(ring.map(([x, y]) => transform([x, y])));
    }
  }
  return rings;
}

async function extractGeojson(zipBuffer, geojsonName) {
  const zip = new AdmZip(zipBuffer);
  const entry = zip
    .getEntries()
    .find((e) => e.entryName.toLowerCase() === `${geojsonName.toLowerCase()}.geojson`);
  if (!entry) {
    throw new Error(
      `${geojsonName}.geojson não encontrado no zip (entradas: ${zip
        .getEntries()
        .map((e) => e.entryName)
        .join(', ')})`,
    );
  }
  return JSON.parse(entry.getData().toString('utf8'));
}

function cellKeyForPoint(x, y, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

async function buildQuadrasBundle({ geojson, labelField, cityLabel, transform }) {
  const features = [];
  for (const f of geojson.features) {
    const rings = ringsFromGeometry(f.geometry, transform);
    if (!rings || rings.length === 0) continue;
    const q = `${f.properties?.[labelField] ?? ''}`.trim();
    features.push({ q, g: { rings } });
  }
  return {
    version: 1,
    wkid: 3857,
    city: cityLabel,
    count: features.length,
    features,
  };
}

async function buildLotesBundle({ geojson, labelField, cityLabel, transform, cellSize = 480 }) {
  const cells = {};
  let count = 0;
  for (const f of geojson.features) {
    const rings = ringsFromGeometry(f.geometry, transform);
    if (!rings || rings.length === 0) continue;
    const n = `${f.properties?.[labelField] ?? ''}`.trim();
    // Centroide simples (média dos vértices do 1o ring) só para indexar a célula.
    const outer = rings[0];
    let sx = 0;
    let sy = 0;
    for (const [x, y] of outer) {
      sx += x;
      sy += y;
    }
    const cx = sx / outer.length;
    const cy = sy / outer.length;
    const key = cellKeyForPoint(cx, cy, cellSize);
    (cells[key] ??= []).push({ n, g: { rings } });
    count++;
  }
  return {
    version: 1,
    wkid: 3857,
    cellSize,
    city: cityLabel,
    count,
    cellCount: Object.keys(cells).length,
    cells,
  };
}

async function run(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const packFolder =
    config.packFolder || (await findPackFolder(config.uf, config.cityFolder));
  const baseUrl = `https://raw.githubusercontent.com/digital-guard/preserv-BR/main/data/${config.uf}/${config.cityFolder}/${packFolder}`;
  console.log(`[${config.citySlug}] pack: ${packFolder}`);
  const yamlText = await fetchText(`${baseUrl}/make_conf.yaml`);
  const parsed = parseMakeConf(yamlText);

  const outputs = {};

  for (const [kind, spec] of [
    ['quarteirao', config.quarteirao],
    ['lote', config.lote],
  ]) {
    if (!spec) continue;
    const fileEntry = findFileForIndex(parsed, spec.zipFileIndex);
    const cacheZipPath = path.join(CACHE_DIR, `${fileEntry.file}`);
    let zipBuffer;
    if (fs.existsSync(cacheZipPath)) {
      zipBuffer = fs.readFileSync(cacheZipPath);
    } else {
      console.log(`[${config.citySlug}] baixando ${kind}: ${fileEntry.file} (${fileEntry.name})`);
      zipBuffer = await downloadBuffer(`https://dl.digital-guard.org/${fileEntry.file}`);
      fs.writeFileSync(cacheZipPath, zipBuffer);
    }
    const geojson = await extractGeojson(zipBuffer, spec.geojsonName);
    const epsg = epsgFromCrsName(geojson.crs?.properties?.name);
    const projKey = await proj4StringForEpsg(epsg);
    const transform =
      projKey === 'EPSG:4326'
        ? ([lon, lat]) => proj4('EPSG:4326', WEBMERCATOR, [lon, lat])
        : ([x, y]) => proj4(projKey, WEBMERCATOR, [x, y]);
    console.log(
      `[${config.citySlug}] ${kind}: ${geojson.features.length} features, EPSG:${epsg}`,
    );

    const bundle =
      kind === 'quarteirao'
        ? await buildQuadrasBundle({
            geojson,
            labelField: spec.labelField,
            cityLabel: config.cityLabel,
            transform,
          })
        : await buildLotesBundle({
            geojson,
            labelField: spec.labelField,
            cityLabel: config.cityLabel,
            transform,
          });

    const outName =
      kind === 'quarteirao'
        ? `${config.citySlug}_quadras_v1.json.gz`
        : `${config.citySlug}_lotes_v1.json.gz`;
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
    fs.writeFileSync(path.join(__dirname, '..', outName), gz);
    outputs[kind] = { file: outName, count: bundle.count };
    console.log(`[${config.citySlug}] ${kind} -> ${outName} (${bundle.count} features, ${(gz.length / 1024).toFixed(0)} KB)`);
  }

  return outputs;
}

const configPath = process.argv[2];
if (!configPath) {
  console.error('Uso: node tools/build_municipal_bundle.js <config.json>');
  process.exit(1);
}
run(configPath).catch((err) => {
  console.error(err);
  process.exit(1);
});
