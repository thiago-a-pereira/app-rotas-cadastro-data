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

As quadras continuam em `v1-*` (não mudaram). Só os **lotes** ganharam versão v2.

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
