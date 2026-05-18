# Epic: ugrc-mcp v0.2 — discovery-first tool surface

**Status:** planning. Source of truth for scope is [docs/plan.md](./plan.md); this epic decomposes it into deliverable stories. Per-story detail lives in [docs/stories/](./stories/).

## Why this epic

v0.1 ships 5 generic tools over a 7-layer hand-curated registry. Connected LLM agents repeatedly ignore them and write Python against ArcGIS REST instead. Diagnosis (plan.md §"The problem"): tool selection is dominated by name/description pattern-matching against user intent, and `query_layer` matches no specific intent. v0.2 fixes this by splitting **discovery** from **action** — many narrow, well-named discovery tools (`list_<category>`, `find_layer`) paired with first-class action primitives (`arcgis_query`, `arcgis_aggregate`, `arcgis_raw`) that take `{ org, layer }` template values, not opaque AGOL URLs.

Final surface: **33 tools** across three coverage tiers — categorized core (235 layers / 20 `list_<category>` tools), live Hub search for the long tail (~528 layers via `find_layer`), and 7 mapserv tools for geocoding + SQL-like search.

## Goals

1. **Eliminate the Python-fallback failure mode** for any UGRC SGID query the catalog covers.
2. **Honest gaps:** when SGID doesn't contain what the user asked for (e.g. parcel owner names — county-held), surface that *before* the agent commits to a useless query.
3. **Long-tail coverage:** any of the ~763 UGRC Feature Services discoverable in ≤2 tool calls.
4. **Composition stays in the model's hands** — no auto-pagination, auto-aggregation, or auto-routing inside tools.
5. **Forward-compatible registry** for v0.3 federation (counties, federal) — `ORGS` schema, not the tool surface, is where new jurisdictions plug in.

## Non-goals (in scope for v0.3+, not this epic)

- Federation across counties / federal / tribal / utilities (only `ugrc` registered).
- Generic ArcGIS server discovery (`discover_arcgis_server`).
- MCP resources surface (`sgid://...`) — discovery is tools-only in v0.2.
- Scheduled registry refresh (manual `npm run sync-sgid-registry` cadence).
- Cross-layer joins or chained-query helpers.
- Write ops, image rendering, attachments-as-first-class.

## Functional requirements

| ID | Requirement |
| --- | --- |
| **F1** | Registered organizations resolve via a hand-maintained `ORGS` map keyed by human handle (`ugrc`), not opaque AGOL IDs. |
| **F2** | The Tier 1 registry (~235 layers across 20 SGID categories) is built by a committed sync script from `agrc/sgid-index` `downloadMetadata.ts` plus per-layer `?f=pjson` enrichment. Output is committed to the repo. |
| **F3** | Per-layer hand-curated notes (`useful_fields`, `gaps`, `caveats`, `time_field`) live in a sidecar `scripts/enrichment.ts` and are merged into the registry at sync time. |
| **F4** | One `list_<category>` discovery tool per SGID category with ≥1 Tier 1 layer (20 tools). Each takes no params; returns full per-layer catalog including `last_edit_date`, `useful_fields`, `gaps`, `caveats`. |
| **F5** | `find_layer({ query, limit? })` searches UGRC's full Hub catalog live, returning `{ name, description, url, last_edit_date, snippet, type }` ready to feed into `arcgis_query({ url, ... })`. |
| **F6** | `arcgis_query` / `arcgis_aggregate` accept *either* `{ org, layer, ... }` (Tier 1) *or* `{ url, ... }` (Tier 2 from `find_layer`). GeoJSON in/out, WGS84. Return shapes match v0.1 (`features` / `exceeded_transfer_limit` / `next_offset`; `groups` / `total_groups`). |
| **F7** | `arcgis_raw({ url, endpoint?, params })` remains the URL-passthrough escape hatch for endpoints `arcgis_query` can't express. |
| **F8** | 7 mapserv tools (geocode, reverse, milepost variants, search, list tables, list fields) wrap https://api.mapserv.utah.gov/. All default `spatialReference=4326`. All return a clear "set `UGRC_API_KEY`" error if the secret is missing. |
| **F9** | `describe_layer` accepts either `{ org, layer }` or `{ url }`; combines cataloged metadata with live pjson re-fetch (so `last_edit_date` is current). |
| **F10** | `list_capabilities` returns the three-tier overview (categories with blurbs + layer counts, mapserv tools, search, query primitives, registered orgs). |
| **F11** | `McpServer.instructions` is set to the policy paragraph from plan.md §"Discovery model" so handshake-time clients show it in the system-prompt area. |
| **F12** | Every `list_<category>` tool description ends with "Pair with `arcgis_query` / `arcgis_aggregate` to pull data" and the `find_layer` fallback nudge. |
| **F13** | Category-level gaps (e.g. cadastre's "NOT owner names — county-held") appear inline in both tool description and catalog return. |

## Non-functional requirements

| ID | Requirement |
| --- | --- |
| **N1** | Sync script tolerates per-layer pjson failures (logs, drops `last_edit_date`, keeps the layer) and uses 5xx retry with backoff. |
| **N2** | No runtime fetch of upstream registry: deploys are reproducible from committed `src/registry/sgid.ts`. |
| **N3** | `find_layer` results capped at 50 entries to sidestep Hub `numberMatched` reliability issues (plan.md risk #8). |
| **N4** | Tool error messages for `{ org, layer }`-resolved URLs surface the resolved URL so 404s tell the user *which* key drifted. |
| **N5** | Geometry-too-large errors keep the v0.1 hint ("pass a smaller polygon, or bbox first"). |
| **N6** | Total tool list cost ~6.5K tokens (33 tools × ~200 tokens) — accepted; measure after Story 5 lands. |
| **N7** | The `describe_layer` per-isolate cache from v0.1 is preserved (module-level `Map`, best-effort). |
| **N8** | `UGRC_API_KEY` is a Worker secret (not committed); README documents `wrangler secret put`. |
| **N9** | All existing v0.1 invariants from CLAUDE.md hold: native `fetch` + `AbortSignal.timeout(30_000)`, hand-rolled GeoJSON↔esriJSON, ArcGIS-200-with-error detection, POST `/query`. |
| **N10** | `npm run typecheck` passes at every story boundary (no half-typed intermediate states on `main`). |

## Stories

| # | Title | Phase(s) | Depends on | Parallelizable with |
| --- | --- | --- | --- | --- |
| **S1** | Registry & data pipeline foundations | 1 | — | S4 |
| **S2** | Query primitives, first-class (`{ org, layer }` / `{ url }`) | 2 | S1 (types) | S3, S4 |
| **S3** | SGID discovery factory + `find_layer` | 3 | S1 (types + data) | S2, S4 |
| **S4** | mapserv tools + API key wiring | 4 | — | S1, S2, S3 |
| **S5** | Discovery polish, wire-up, cutover (instructions, `list_capabilities`, `describe_layer` rewrite, remove v0.1 leftovers, docs) | 5 + 6 | S1, S2, S3, S4 | — |

Story files at `docs/stories/01-registry-foundations.md` … `docs/stories/05-discovery-polish-cutover.md` carry the detailed task lists, file inventories, and per-story acceptance criteria.

### Critical path

```
S1 ──┬─→ S2 ─┐
     ├─→ S3 ─┼─→ S5
S4 ──────────┘
```

S4 has no code dependency on S1 — it can start immediately. S2 and S3 unblock once S1 ships the registry types (the committed `sgid.ts` data isn't strictly required for S2's typechecking but is for S3's catalog returns).

## Epic-level acceptance criteria

The five conversations from plan.md §"Acceptance criteria" must pass in MCP Inspector with a fresh agent connection (no pre-prompting):

1. **A1 — Tier 1 aggregation:** *"How many acres of irrigated alfalfa in Utah in 2023?"* → `list_farming` → `arcgis_aggregate({ org: "ugrc", layer: "wrlu", ... })`. **No Python.**
2. **A2 — mapserv:** *"What's the street address at 40.7608° N, 111.8910° W?"* → `reverse_geocode`. **No curl.**
3. **A3 — Tier 1 query:** *"Which parcels overlap this polygon?"* → `list_cadastre` → `arcgis_query({ org: "ugrc", layer: "parcels_lir", geometry: {...} })`. **No manual URL composition.**
4. **A4 — Stratos / honest gaps:** *"Who owns the parcels inside this polygon?"* (Box Elder polygon) → `list_cadastre`, reads `category_gaps`, **explains the owner-names gap to the user, recommends the v0.3 county-portal path or `arcgis_raw`. Must not hallucinate that LIR contains owners.**
5. **A5 — Tier 2 long-tail:** *"Show me Utah's springs."* → `find_layer({ query: "springs" })` → `arcgis_query({ url: <NHD springs URL>, ... })`. **No assumption that the data doesn't exist.**

A4 is the canonical regression test for the hallucination/gap pattern that motivated the whole discovery split. A5 is the regression test for the long-tail coverage that motivated the Hub Search tier.

## Risks (epic-level)

Carried from plan.md §Risks; story files own the mitigation tactics:

- **R1** Upstream `downloadMetadata.ts` rename/move → pin SHA in sync script. (S1)
- **R2** mapserv rate limit not documented → README nudges self-deploy; WAF rule if abused. (S4)
- **R3** Tool list token cost — measured after S5. (S5)
- **R4** Catalog payload size (cadastre is ~64 layers, ~30KB JSON) — flag if any client truncates. (S3)
- **R5** SGID URL drift — sync script can't catch silent renames; tool errors include resolved `{ org, layer }` for fast diagnosis. (S1, S2)
- **R6** `arcgis_query` discoverability — if the description doesn't sell the pairing, agents may revert to Python. Acceptance tests A1/A3/A5 are the regression bar. (S2, S5)
- **R7** Hub Search hard dependency for Tier 2 — accepted; if ArcGIS is down, the whole MCP is too. (S3)
- **R8** Hub `numberMatched` reliability — cap `find_layer` at 50 results. (S3)

## Out-of-scope reminders (don't drift)

Anything in plan.md §"Out of scope for v0.2" stays out — especially: county/federal/tribal federation, generic ArcGIS server discovery, MCP resources surface, scheduled registry refresh, cross-layer join helpers.
