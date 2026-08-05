// Utilitários compartilhados de extração de arquivo (zip ou rar) e parse do
// make_conf.yaml, usados por build_municipal_bundle.js e inspect_layer.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

const UNRAR_CANDIDATES = [
  'C:/Program Files/WinRAR/UnRAR.exe',
  'C:/Program Files (x86)/WinRAR/UnRAR.exe',
];

function findUnrar() {
  for (const candidate of UNRAR_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('UnRAR.exe não encontrado (esperado no WinRAR instalado).');
}

/// Extrai um buffer de arquivo (.zip ou .rar, pela extensão) pra um
/// diretório temporário e devolve a lista de caminhos de arquivo (recursiva,
/// sem __MACOSX/lixo de metadado do macOS).
function extractArchiveToTempDir(buffer, fileName) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4a-archive-'));
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.zip') {
    const zip = new AdmZip(buffer);
    zip.extractAllTo(tmpDir, true);
  } else if (ext === '.rar') {
    const rarPath = path.join(tmpDir, 'a.rar');
    fs.writeFileSync(rarPath, buffer);
    const unrar = findUnrar();
    execFileSync(unrar, ['x', '-y', rarPath, tmpDir + path.sep], { stdio: 'pipe' });
    fs.unlinkSync(rarPath);
  } else {
    throw new Error(`Extensão de arquivo não suportada: ${ext}`);
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(tmpDir);
  return { tmpDir, files: out };
}

function findFile(files, origFilename, extension) {
  const wanted = origFilename.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const wantedBase = path.basename(wanted);
  const candidates = files.filter((f) => f.toLowerCase().endsWith(extension));
  let found = candidates.find(
    (f) => f.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/\\/g, '/').endsWith(wanted.replace(/\\/g, '/')),
  );
  if (!found) {
    found = candidates.find((f) => path.basename(f).toLowerCase().replace(/\.[a-z0-9]+$/, '') === wantedBase);
  }
  if (!found && candidates.length === 1) found = candidates[0];
  return found;
}

// Parser do make_conf.yaml (estrutura fixa, não é YAML geral). Suporta os
// dois jeitos de declarar a projeção vistos até agora: `codec:descr_encode:
// srid=NNNN` (a maioria) ou `srid_proj: <string proj4 completa>` (Manaus).
function parseMakeConf(yamlText) {
  const files = [];
  const fileBlockRe = /-\s*file:\s*(\S+)[\s\S]*?(?=\n-\s*file:|\nlicense_evidences:|\nlayers:|$)/g;
  let m;
  while ((m = fileBlockRe.exec(yamlText))) {
    const file = m[1];
    const p = /p:\s*(\d+)/.exec(m[0])?.[1];
    files.push({ file, p: p ? Number(p) : null });
  }
  const srid = /codec:descr_encode:\s*srid=(\d+)/.exec(yamlText)?.[1];
  const sridProj = /^srid_proj:\s*(.+)$/m.exec(yamlText)?.[1]?.trim();

  const layers = {};
  for (const key of ['parcel', 'block']) {
    const re = new RegExp(`^  ${key}:\\s*\\n((?:^(?!  \\w).*\\n?)*)`, 'm');
    const m2 = re.exec(yamlText);
    if (!m2) continue;
    const block = m2[1];
    const file = /file:\s*(\d+)/.exec(block)?.[1];
    const method = /method:\s*(\S+)/.exec(block)?.[1];
    const origFilename = /orig_filename:\s*'?([^'\n]+)'?/.exec(block)?.[1]?.trim();
    if (file && method) {
      layers[key] = { file: Number(file), method, origFilename };
    }
  }
  return {
    files,
    layers,
    srid: srid ? Number(srid) : null,
    sridProj: sridProj || null,
  };
}

module.exports = { extractArchiveToTempDir, findFile, parseMakeConf };
