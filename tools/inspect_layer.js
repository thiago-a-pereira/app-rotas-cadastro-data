// Inspeciona uma amostra de propriedades de uma camada (parcel/block) de uma
// cidade, pra decidir o labelField antes de escrever a config completa.
// Uso: node tools/inspect_layer.js <UF> <CityFolder|null> [packFolder]

const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');
const { extractArchiveToTempDir, findFile, parseMakeConf } = require('./archive_utils');

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

async function main() {
  const [uf, cityFolderArg, packFolderArg] = process.argv.slice(2);
  const cityFolder = cityFolderArg === 'null' ? null : cityFolderArg;
  const cityPath = cityFolder ? `${uf}/${cityFolder}` : uf;
  let packFolder = packFolderArg;
  if (!packFolder) {
    const listing = await fetchJson(`https://api.github.com/repos/digital-guard/preserv-BR/contents/data/${cityPath}`);
    packFolder = listing.filter((e) => e.type === 'dir')[0].name;
  }
  const baseUrl = `https://raw.githubusercontent.com/digital-guard/preserv-BR/main/data/${cityPath}/${packFolder}`;
  const yamlText = await fetchText(`${baseUrl}/make_conf.yaml`);
  const parsed = parseMakeConf(yamlText);
  console.log(`pack=${packFolder} srid=${parsed.srid} sridProj=${parsed.sridProj ? 'sim' : 'nao'}`);

  for (const key of ['parcel', 'block']) {
    const layerDef = parsed.layers[key];
    if (!layerDef) {
      console.log(`--- ${key}: ausente ---`);
      continue;
    }
    console.log(`--- ${key}: file=${layerDef.file} method=${layerDef.method} orig=${layerDef.origFilename} ---`);
    if (layerDef.method !== 'geojson2sql' && layerDef.method !== 'shp2sql') {
      console.log('  (method não suportado, pulando amostra)');
      continue;
    }
    const fileEntry = parsed.files.find((f) => f.p === layerDef.file);
    const cacheDir = path.join(__dirname, '..', '.cache', 'zips');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, fileEntry.file);
    let buf;
    if (fs.existsSync(cachePath)) buf = fs.readFileSync(cachePath);
    else {
      buf = await downloadBuffer(`https://dl.digital-guard.org/${fileEntry.file}`);
      fs.writeFileSync(cachePath, buf);
    }
    const { tmpDir, files } = extractArchiveToTempDir(buf, fileEntry.file);
    try {
      if (layerDef.method === 'geojson2sql') {
        const found = findFile(files, layerDef.origFilename, '.geojson');
        if (!found) {
          console.log('  .geojson não achado. entradas:', files.join(', '));
          continue;
        }
        const geojson = JSON.parse(fs.readFileSync(found, 'utf8'));
        console.log('  count:', geojson.features.length, 'crs:', JSON.stringify(geojson.crs));
        console.log('  props[0]:', JSON.stringify(geojson.features[0]?.properties));
        console.log('  props[1]:', JSON.stringify(geojson.features[1]?.properties));
      } else {
        const shpPath = findFile(files, layerDef.origFilename, '.shp');
        if (!shpPath) {
          console.log('  .shp não achado. entradas:', files.join(', '));
          continue;
        }
        const base = shpPath.slice(0, -4).toLowerCase();
        const dbfPath = files.find((f) => f.toLowerCase() === base + '.dbf');
        const cpgPath = files.find((f) => f.toLowerCase() === base + '.cpg');
        let encoding = 'latin1';
        if (cpgPath) {
          const cpg = fs.readFileSync(cpgPath, 'utf8').trim().toUpperCase();
          if (cpg.includes('UTF-8') || cpg.includes('UTF8')) encoding = 'utf8';
        }
        const source = await shapefile.open(
          fs.readFileSync(shpPath),
          dbfPath ? fs.readFileSync(dbfPath) : undefined,
          { encoding },
        );
        const r1 = await source.read();
        const r2 = await source.read();
        console.log('  props[0]:', JSON.stringify(r1.value?.properties));
        console.log('  props[1]:', JSON.stringify(r2.value?.properties));
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('[erro]', err.message);
  process.exit(1);
});
