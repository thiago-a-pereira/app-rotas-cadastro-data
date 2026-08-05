# app-rotas-cadastro-data

Dados de cadastro municipal (quadras e lotes) e índices de geocodificação usados
pelo app **app-rotas**. Os arquivos pesados são publicados como **assets de
Release** (não versionados no git); este repositório guarda apenas as
ferramentas de geração em `tools/`.

## Releases

| Tag | Assets | Conteúdo |
| --- | --- | --- |
| `v1-goiania` | `goiania_quadras_v1.json.gz`, `goiania_lotes_v1.json.gz` | Quadras/lotes de Goiânia (Web Mercator 3857) |
| `v1-aparecida` | `aparecida_quadras_v1.json.gz`, `aparecida_lotes_v1.json.gz` | Quadras/lotes de Aparecida de Goiânia |
| `v1-geocode` | `goiania_geocode_v1.json.gz`, `aparecida_geocode_v1.json.gz` | Índice bairro → quadra → lote → `[lat, lng]` |
| `v2-goiania` | `goiania_lotes_v2.json.gz` | Lotes de Goiânia **com a quadra (`q`) embutida em cada lote** |
| `v2-aparecida` | `aparecida_lotes_v2.json.gz` | Lotes de Aparecida **com a quadra (`q`) embutida em cada lote** |
| `v1-bage` | `bage_quadras_v1.json.gz`, `bage_lotes_v1.json.gz` | Quadras/lotes de Bagé/RS (dados brutos AddressForAll, ver abaixo) |

As quadras continuam em `v1-*` (não mudaram). Só os **lotes** ganharam versão v2.

## Municípios novos (além de Goiânia/Aparecida)

O FeatureServer ArcGIS ao vivo da AddressForAll dá **499 Token Required** em
todo o catálogo (confirmado 24-27/07/2026, inclusive nas 3 cidades que já
estavam configuradas no app pelo FeatureServer — Sorocaba/Atibaia/Recife).
O caminho que funciona é baixar os dados BRUTOS doados
(github.com/digital-guard/preserv-BR) e converter, mesmo padrão do que já era
feito manualmente para Aparecida/Goiânia.

`tools/build_municipal_bundle.js` automatiza isso:

1. Acha a pasta do pack em `data/{UF}/{Cidade}/` no preserv-BR (GitHub).
2. Lê `make_conf.yaml` dessa pasta — lista os arquivos brutos por sha256
   (baixáveis direto em `https://dl.digital-guard.org/{sha256}.zip`) e qual
   arquivo (`file: N`) é quadra (`layers.block`) ou lote (`layers.parcel`).
3. Baixa o zip, extrai o GeoJSON, lê o CRS de origem (`crs.properties.name`
   no próprio arquivo — não precisa adivinhar zona UTM) e resolve a projeção
   via `epsg.io/{code}.proj4`.
4. Reprojeta pra Web Mercator (3857) e grava no mesmo formato v1 usado por
   Goiânia/Aparecida.

**Não há padrão fixo de nome de propriedade pro rótulo do lote/quadra** —
cada prefeitura digitalizou do seu jeito (ex.: Bagé usa `numero`/`baiqd`,
Aparecida usava um campo `SUP` tipo "Q.5, LT.10"). Por isso a config de cada
cidade (`configs/*.json`) precisa ser escrita depois de inspecionar uma
amostra real do GeoJSON baixado (`zipFileIndex` vem de `make_conf.yaml`,
`labelField` vem da inspeção manual).

```sh
node tools/build_municipal_bundle.js configs/bage.json
# gera bage_quadras_v1.json.gz e bage_lotes_v1.json.gz no diretório atual;
# depois: criar Release `v1-<slug>` no GitHub e subir os 2 arquivos como assets.
```

Cidade nova no app = (1) rodar o script, (2) publicar o Release, (3)
registrar em `_municipalCadastreConfigs` (`arcgis_native_route_map.dart`) +
preset em `arcgisKnownBrazilOperationalLayerPresets`
(`arcgis_operational_layers.dart`) no app-rotas.

## Formatos

- **Quadras** (`*_quadras_v1.json.gz`): `{ version, wkid, city, count, features: [{ q, g: { rings } }] }`.
- **Lotes v1** (`*_lotes_v1.json.gz`): cell-indexed — `{ version, wkid, cellSize, city, count, cellCount, cells: { "cx:cy": [{ n, g: { rings } }] } }`.
- **Lotes v2** (`*_lotes_v2.json.gz`): igual ao v1, mas cada lote ganha o campo
  `q` com o número da quadra (`{ n, g, q }`). Lotes sem quadra resolvida ficam
  sem `q`. `version` passa a `2` e há um bloco `quadraJoin` com os parâmetros.

## Ferramentas

- `tools/build_goiania_geocode_index.js` / `tools/build_aparecida_geocode_index.js`
  — geram os índices `v1-geocode` raspando o portal/derivando dos shapefiles.
- `tools/build_lotes_with_quadra.js` — gera os bundles **v2** de lotes a partir
  dos Releases v1 já publicados, fazendo um **join espacial**: a quadra de cada
  lote é aquela cujo polígono contém o centroide do lote (índice em grade +
  fallback por quadra mais próxima). Não depende do portal.

  ```sh
  node tools/build_lotes_with_quadra.js
  # gera goiania_lotes_v2.json.gz e aparecida_lotes_v2.json.gz no diretório atual
  ```

  Cobertura medida (2026-06): ~99,8% dos lotes recebem quadra nas duas cidades.
  Validação cruzada contra o índice `v1-geocode`: >99,8% dos pontos de endereço
  caem a menos de 25 m de um lote e a quadra atribuída coincide com a do
  endereçamento.
