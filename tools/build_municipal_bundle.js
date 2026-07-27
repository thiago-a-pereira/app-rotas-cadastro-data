// Gera bundles de quadras/lotes (mesmo formato v1: ver README.md) para um
// município a partir dos dados brutos publicados pela AddressForAll/
// digital-guard em https://github.com/digital-guard/preserv-BR.
//
// Achado (2026-07-27): cada município tem uma pasta data/{UF}/{Cidade}/_pk{donor}.{pack}
// com um make_conf.yaml listando os arquivos brutos (nome = sha256, baixável
// direto em https://dl.digital-guard.org/{sha256}.{zip|rar}), o srid de
// origem (codec:descr_encode OU srid_proj, formato varia por cidade) e, por
// camada (parcel/block), o `file` e `method` (geojson2sql ou shp2sql — a
// maioria das cidades é shapefile bruto, só Bagé/RJ vieram como GeoJSON
// pronto; alguns arquivos são .rar em vez de .zip, ex. Manaus). Este script
// lê o make_conf.yaml automaticamente — só pede o campo de rótulo do lote/
// quadra por cidade (não tem nome de propriedade padrão entre municípios,
// inspecionar com `node tools/inspect_layer.js` antes).
//
// Métodos NÃO suportados ainda (pula com aviso): gdb2sql (File Geodatabase),
// ogr2ogr de formatos exóticos (dxf/gpkg).
//
// Uso:
//   node tools/build_municipal_bundle.js configs/<slug>.json
//
// Config:
// {
//   "citySlug": "toledo", "cityLabel": "Toledo/PR",
//   "uf": "PR", "cityFolder": "Toledo",
//   "packFolder": "_pk0079.01",   // opcional; autodetecta (1a pasta) se omitido
//   "quarteiraoLabelField": null,  // null = sem rótulo (só contorno)
//   "loteLabelField": "numero"
// }

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const proj4 = require('proj4');
const shapefile = require('shapefile');
const { extractArchiveToTempDir, findFile, parseMakeConf } = require('./archive_utils');

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const ZIP_CACHE_DIR = path.join(CACHE_DIR, 'zips');
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
  const cityPath = cityFolder ? `${uf}/${cityFolder}` : uf;
  const listing = await fetchJson(`https://api.github.com/repos/digital-guard/preserv-BR/contents/data/${cityPath}`);
  const dirs = listing.filter((e) => e.type === 'dir');
  if (dirs.length === 0) throw new Error(`Nenhuma pasta de pack em data/${cityPath}`);
  return dirs[0].name;
}

async function proj4StringForEpsg(epsgCode) {
  if (epsgCode === 4326 || epsgCode === 4674 || epsgCode === 'CRS84') return 'EPSG:4326';
  const key = `EPSG:${epsgCode}`;
  if (proj4DefCache.has(key)) return key;
  const def = await fetchText(`https://epsg.io/${epsgCode}.proj4`);
  proj4.defs(key, def.trim());
  proj4DefCache.set(key, key);
  return key;
}

const WEBMERCATOR =
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs';
const CUSTOM_PROJ_KEY = 'CUSTOM_SOURCE';

function epsgFromCrsName(crsName) {
  if (!crsName) return 4326;
  if (crsName.includes('CRS84')) return 4326;
  const m = /EPSG::?(\d+)/.exec(crsName);
  if (m) return Number(m[1]);
  throw new Error(`CRS não reconhecido: ${crsName}`);
}

function ringsFromGeometry(geometry, transform) {
  if (!geometry) return null;
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

async function downloadZipCached(sha256File, label) {
  fs.mkdirSync(ZIP_CACHE_DIR, { recursive: true });
  const cachePath = path.join(ZIP_CACHE_DIR, sha256File);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);
  console.log(`  baixando ${label}: ${sha256File}`);
  const buf = await downloadBuffer(`https://dl.digital-guard.org/${sha256File}`);
  fs.writeFileSync(cachePath, buf);
  return buf;
}

/// Extrai features (GeoJSON-like: {properties, geometry}) de um archive,
/// seja GeoJSON pronto (method geojson2sql) ou shapefile bruto (shp2sql).
async function extractFeatures(archiveBuffer, archiveFileName, layerDef) {
  const { tmpDir, files } = extractArchiveToTempDir(archiveBuffer, archiveFileName);
  try {
    if (layerDef.method === 'geojson2sql') {
      const found = findFile(files, layerDef.origFilename, '.geojson');
      if (!found) throw new Error(`.geojson não achado pra "${layerDef.origFilename}" (${files.length} arquivos no archive)`);
      const geojson = JSON.parse(fs.readFileSync(found, 'utf8'));
      const epsg = epsgFromCrsName(geojson.crs?.properties?.name);
      return { features: geojson.features, epsg };
    }
    if (layerDef.method === 'shp2sql') {
      const shpPath = findFile(files, layerDef.origFilename, '.shp');
      if (!shpPath) throw new Error(`.shp não achado pra "${layerDef.origFilename}" (${files.length} arquivos no archive)`);
      const base = shpPath.slice(0, -4).toLowerCase();
      const dbfPath = files.find((f) => f.toLowerCase() === base + '.dbf');
      const cpgPath = files.find((f) => f.toLowerCase() === base + '.cpg');
      // DBF antigo (a maioria dos shapefiles municipais brasileiros pré-2020)
      // não é UTF-8 — sem o .cpg (poucas cidades têm), acentos viram mojibake.
      // Bagé tinha .cpg="UTF-8" e funcionou; o default seguro pra quem não
      // declara é latin1 (western europe / ISO-8859-1), o mais comum nesses
      // dados.
      let encoding = 'latin1';
      if (cpgPath) {
        const cpg = fs.readFileSync(cpgPath, 'utf8').trim().toUpperCase();
        if (cpg.includes('UTF-8') || cpg.includes('UTF8')) encoding = 'utf8';
      }
      // Buffers, não paths: a lib `shapefile` decide se já tem a extensão
      // ".dbf" com uma regex case-SENSITIVE (`/\.dbf$/`) — arquivo extraído
      // com ".DBF" maiúsculo (ex.: Vila Velha) engana o teste e ela concatena
      // ".dbf" de novo, quebrando o path. Passar os bytes já lidos evita essa
      // lógica de sufixo por completo.
      const shpBuffer = fs.readFileSync(shpPath);
      const dbfBuffer = dbfPath ? fs.readFileSync(dbfPath) : undefined;
      const source = await shapefile.open(shpBuffer, dbfBuffer, { encoding });
      const features = [];
      let result;
      while (!(result = await source.read()).done) features.push(result.value);
      return { features, epsg: null }; // resolvido pelo srid global do pack
    }
    throw new Error(`method não suportado: ${layerDef.method}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function cellKeyForPoint(x, y, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

function buildQuadrasBundle({ features, labelField, cityLabel, transform }) {
  const out = [];
  for (const f of features) {
    const rings = ringsFromGeometry(f.geometry, transform);
    if (!rings || rings.length === 0) continue;
    const q = labelField ? `${f.properties?.[labelField] ?? ''}`.trim() : '';
    out.push({ q, g: { rings } });
  }
  return { version: 1, wkid: 3857, city: cityLabel, count: out.length, features: out };
}

function buildLotesBundle({ features, labelField, cityLabel, transform, cellSize = 480 }) {
  const cells = {};
  let count = 0;
  for (const f of features) {
    const rings = ringsFromGeometry(f.geometry, transform);
    if (!rings || rings.length === 0) continue;
    const n = labelField ? `${f.properties?.[labelField] ?? ''}`.trim() : '';
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
  return { version: 1, wkid: 3857, cellSize, city: cityLabel, count, cellCount: Object.keys(cells).length, cells };
}

// Sanity check: um ponto de amostra deve cair dentro do Brasil continental.
function assertInsideBrazil(rings, citySlug, kind) {
  const [x, y] = rings[0][0];
  const lon = (x / 20037508.34) * 180;
  const lat = (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90;
  if (lon < -74 || lon > -34 || lat < -34 || lat > 6) {
    throw new Error(
      `${citySlug} ${kind}: ponto de amostra fora do Brasil (lon=${lon.toFixed(2)}, lat=${lat.toFixed(2)}) — CRS errado?`,
    );
  }
}

async function run(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const packFolder = config.packFolder || (await findPackFolder(config.uf, config.cityFolder));
  const cityPath = config.cityFolder ? `${config.uf}/${config.cityFolder}` : config.uf;
  const baseUrl = `https://raw.githubusercontent.com/digital-guard/preserv-BR/main/data/${cityPath}/${packFolder}`;
  console.log(`[${config.citySlug}] pack: ${packFolder}`);
  const yamlText = await fetchText(`${baseUrl}/make_conf.yaml`);
  const parsed = parseMakeConf(yamlText);

  if (parsed.sridProj) {
    proj4.defs(CUSTOM_PROJ_KEY, parsed.sridProj);
  }

  const outputs = {};
  const layerSpecs = [
    ['quarteirao', 'block', config.quarteiraoLabelField],
    ['lote', 'parcel', config.loteLabelField],
  ];

  for (const [kind, layerKey, labelField] of layerSpecs) {
    const layerDef = parsed.layers[layerKey];
    if (!layerDef) {
      console.log(`[${config.citySlug}] ${kind}: sem layer ${layerKey} no make_conf.yaml, pulando.`);
      continue;
    }
    // Override manual do orig_filename: alguma cidades declaram o
    // orig_filename como lista (ex.: Joinville "['a','b']", urbano+rural
    // combinados) — o parser não separa isso, então a config da cidade pode
    // apontar pro arquivo único que interessa.
    const origFilenameOverrideKey = kind === 'quarteirao' ? 'quarteiraoOrigFilename' : 'loteOrigFilename';
    if (config[origFilenameOverrideKey]) {
      layerDef.origFilename = config[origFilenameOverrideKey];
    }
    if (layerDef.method !== 'geojson2sql' && layerDef.method !== 'shp2sql') {
      console.warn(`[${config.citySlug}] ${kind}: method "${layerDef.method}" não suportado ainda — pulando.`);
      continue;
    }
    const fileEntry = parsed.files.find((f) => f.p === layerDef.file);
    if (!fileEntry) throw new Error(`Nenhum arquivo com p=${layerDef.file} em make_conf.yaml`);
    const archiveBuffer = await downloadZipCached(fileEntry.file, `${kind} (${layerDef.origFilename})`);
    const { features, epsg: geojsonEpsg } = await extractFeatures(archiveBuffer, fileEntry.file, layerDef);
    const epsg = geojsonEpsg ?? parsed.srid;
    if (!epsg && !parsed.sridProj) {
      throw new Error(`${config.citySlug} ${kind}: sem SRID (nem no GeoJSON, nem srid=, nem srid_proj)`);
    }
    const projKey = epsg ? await proj4StringForEpsg(epsg) : CUSTOM_PROJ_KEY;
    const transform =
      projKey === 'EPSG:4326'
        ? ([lon, lat]) => proj4('EPSG:4326', WEBMERCATOR, [lon, lat])
        : ([x, y]) => proj4(projKey, WEBMERCATOR, [x, y]);
    console.log(
      `[${config.citySlug}] ${kind}: ${features.length} features, ${epsg ? `EPSG:${epsg}` : 'srid_proj'}, method=${layerDef.method}`,
    );

    const bundle =
      kind === 'quarteirao'
        ? buildQuadrasBundle({ features, labelField, cityLabel: config.cityLabel, transform })
        : buildLotesBundle({ features, labelField, cityLabel: config.cityLabel, transform });

    if (bundle.count === 0) {
      console.warn(`[${config.citySlug}] ${kind}: 0 features válidas, pulando output.`);
      continue;
    }
    const sampleRings =
      kind === 'quarteirao' ? bundle.features[0].g.rings : bundle.cells[Object.keys(bundle.cells)[0]][0].g.rings;
    assertInsideBrazil(sampleRings, config.citySlug, kind);

    const outName = kind === 'quarteirao' ? `${config.citySlug}_quadras_v1.json.gz` : `${config.citySlug}_lotes_v1.json.gz`;
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
  console.error(`[erro] ${err.stack || err.message}`);
  process.exit(1);
});
