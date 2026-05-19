# Story 3 — SGID discovery factory + `find_layer`

**Summary:** Build the 20 `list_<category>` Tier 1 discovery tools (via a factory over `SGID_CATEGORIES`) plus the Tier 2 `find_layer` Hub Search wrapper, exported as registration functions Story 5 wires into `mcp.ts`.

## Goal

Tool names are the search index. v0.1's single generic `list_layers` matches no specific user intent, so connected agents skip it and write Python. v0.2 replaces it with 20 narrow `list_<category>` tools whose names (`list_cadastre`, `list_water`, …) directly pattern-match against the shape of user questions, plus a `find_layer` tool that searches the uncategorized long tail live against UGRC's full Hub catalog. The most important second-order effect is **honest gaps surfaced inline**: every per-category tool carries its `category_gaps` string both in the tool description *and* in the catalog return payload, so the model sees "owner names are NOT in SGID" before it commits to a useless query (this is the Stratos failure mode the whole epic is designed around — see epic A4). One generic tool that returns "here's what's in this category and here's what's deliberately missing" beats a federation of generic primitives the model has to compose blind.

## What this story IS

- A factory in `src/tools/sgid.ts` that walks the committed `SGID_CATEGORIES` data (from Story 1) and emits one `list_<category>` tool per entry — no per-category hand-written code.
- A consistent per-tool catalog return shape: `{ category, blurb, category_gaps, layers: [{ org, layer, name, steward, geometry_type, last_edit_date, max_record_count, useful_fields, gaps, caveats }] }`.
- A consistent per-tool description built from the plan.md template, with the category's `category_gaps` inlined and the `find_layer` fallback nudge appended.
- `src/tools/hub-search.ts` exposing `findLayer({ query, limit? })` — a thin wrapper over the ArcGIS Hub Search v1 dataset-items endpoint, filtered to UGRC's org + Feature Service type, with results normalized to `{ name, description, url, last_edit_date, snippet, type }` and capped at 50.
- Both files export **registration functions** (e.g. `registerSgidTools(server)`, `registerHubSearchTool(server)`) that Story 5 calls from `mcp.ts`. The factory + wrapper themselves are pure modules that don't touch the `McpServer` directly outside those exported registrars.

## What this story IS NOT

- **NOT** the `mcp.ts` wire-up — Story 5 imports and invokes the registration functions.
- **NOT** `arcgis_query` / `arcgis_aggregate` / `arcgis_raw` — those are Story 2.
- **NOT** `describe_layer` (rewrite to accept `{ org, layer }` or `{ url }`) — Story 5.
- **NOT** `list_capabilities` — Story 5.
- **NOT** mapserv tools — Story 4.
- **NOT** removal of v0.1's `list_layers` / `query_layer` / `aggregate_layer` / `arcgis_query_raw` — Story 5 handles the cutover.
- **NOT** any change to the registry sync script or `enrichment.ts` — that's Story 1.

## Dependencies

- **Depends on Story 1:** the committed `src/registry/sgid.ts` (with `SGID_CATEGORIES` keyed by category name, each entry carrying `blurb`, `category_gaps`, and a `layers[]` array of `LayerEntry`) and the `LayerEntry` type. Also depends on `src/registry/orgs.ts` so the factory can name the registered org in errors.
- **Can run in parallel with Story 2 and Story 4** — no code dependency.
- **Unblocks Story 5**, which calls `registerSgidTools` / `registerHubSearchTool` from `mcp.ts`, sets `McpServer.instructions`, and implements `list_capabilities`.

## Files created

- `src/tools/sgid.ts` — the per-category tool factory plus `registerSgidTools(server)`.
- `src/tools/hub-search.ts` — `findLayer(...)` plus `registerHubSearchTool(server)`.

## Files edited

None. Story 5 owns the `mcp.ts` change.

## Task list

1. **SGID category factory (`src/tools/sgid.ts`)**
   1. Import `SGID_CATEGORIES` and `LayerEntry` from `src/registry/sgid.ts`; import `ORGS` from `src/registry/orgs.ts` (used only for description copy if useful).
   2. Implement an internal `buildCategoryDescription(categoryKey, entry)` that produces the description string from the plan.md template — see "Tool description copy" below. Must inline `entry.category_gaps` and always end with the `find_layer` fallback sentence.
   3. Implement an internal `buildCategoryResponse(categoryKey, entry)` that returns the catalog JSON shape (see "Return shape examples"). Pure — no I/O; reads only from the in-memory registry.
   4. Export `registerSgidTools(server: McpServer)`. Body iterates `Object.entries(SGID_CATEGORIES)` and calls `server.tool("list_" + categoryKey, description, {} /* no params */, async () => text(buildCategoryResponse(...)))` for each entry. Following the v0.1 `text(...)` helper convention in `src/mcp.ts`.
   5. Tool name = literally `list_<categoryKey>` (e.g. `list_cadastre`, `list_water`). Category keys come straight from `SGID_CATEGORIES`; the registry is the single source of truth for which 20 tools exist.
   6. Tool takes **no parameters** (empty zod object schema).
2. **Hub Search wrapper (`src/tools/hub-search.ts`)**
   1. Export an internal async `findLayer({ query, limit })` function (`limit` defaults to 25, clamped to 50 per N3 + risk #8).
   2. Build the filter string: `orgid='99lidPhWCzftIe9K' AND type='Feature Service' AND (` + the user's `query` clause + `)`. Use the same single-org constant available via `ORGS.ugrc.agol_id`.
   3. GET `https://hub.arcgis.com/api/search/v1/collections/dataset/items` with query params `filter=<above>`, `limit=<clamped>`. Reuse the v0.1 `AbortSignal.timeout(30_000)` + 5xx retry/backoff pattern from `src/arcgis.ts` — preferably by extracting it into `src/arcgis-client.ts` (Story 2) or, if Story 2 hasn't landed, by mirroring the pattern locally and leaving a TODO to dedupe.
   4. Normalize each Hub item to `{ name, description, url, last_edit_date, snippet, type }`:
      - `name` ← item `title` or `properties.name`.
      - `description` ← item `description`, truncated to ~500 chars.
      - `url` ← the Feature Service URL from `properties.url` or the layer-level URL; must be usable directly as `arcgis_query({ url, ... })` input.
      - `last_edit_date` ← from `properties.modified` (ISO date string).
      - `snippet` ← matched-text snippet from the Hub response, if present; otherwise first 200 chars of description.
      - `type` ← always `"Feature Service"` for v0.2 (the filter guarantees it).
   5. Return `{ results: [...], total_returned: results.length, capped_at: 50, query }`.
   6. Export `registerHubSearchTool(server: McpServer)`. Registers the `find_layer` tool with the description in "Tool description copy" below, the zod schema `{ query: z.string().min(1), limit: z.number().int().min(1).max(50).default(25) }`, and a handler that calls `findLayer(params)`.
3. **Typecheck.** Run `npm run typecheck`; the factory should compile cleanly against the Story 1 registry types.

## Tool description copy

### Template (per plan.md §"Discovery: SGID per-category")

> Discover Utah {DisplayName} layers — {Blurb}. {Category-level gaps inline.} Returns a catalog with per-layer freshness, fields, and known gaps. Pair with `arcgis_query` / `arcgis_aggregate` to pull data. If the layer you need isn't here, try `find_layer({ query })` for the uncategorized ~528 UGRC services. Layers ({count}): {comma-separated keys}.

The closing sentence **"Pair with `arcgis_query` / `arcgis_aggregate` to pull data. If the layer you need isn't here, try `find_layer({ query })`."** is mandatory in every emitted description (F12). The `{Category-level gaps inline.}` slot is the F13 requirement and must render `entry.category_gaps` verbatim — if the registry entry has no gaps for a category, the factory omits that sentence rather than inserting filler.

### Worked example — `list_cadastre`

The canonical instance, because cadastre carries the owner-names gap that motivated the discovery split:

> Discover Utah Cadastre layers — parcels, taxation, zoning. **NOT owner names — those are county-held, not in SGID.** Returns a catalog with per-layer freshness, fields, and known gaps. Pair with `arcgis_query` / `arcgis_aggregate` to pull data. If the layer you need isn't here, try `find_layer({ query })`. Layers (64): `parcels_lir`, `parcels_basic`, `tax_districts`, `municipal_boundaries`, …

### `find_layer` description (full string)

> Search UGRC's full ArcGIS Hub catalog live (~763 Feature Services) for layers matching a free-text query. Use this **Tier 2** entry point when no `list_<category>` tool surfaces the layer you need — there are ~528 UGRC services that aren't in the categorized core. Returns matching layers with `{ name, description, url, last_edit_date, snippet, type }`. The returned `url` is ready to pass directly to `arcgis_query({ url, ... })` / `arcgis_aggregate({ url, ... })`. Results are capped at 50. Example: `find_layer({ query: "springs" })` surfaces the NHD Springs layer for hydrography questions `list_water` (6 layers) doesn't cover.

## Return shape examples

### `list_cadastre()` return

```json
{
  "category": "cadastre",
  "blurb": "Parcels, taxation, zoning",
  "category_gaps": "Owner names are NOT in SGID — they're county-held. Query the relevant county portal directly (v0.3 will register counties). For now, use arcgis_raw against the county AGOL org if you know the URL.",
  "layers": [
    {
      "org": "ugrc",
      "layer": "parcels_lir",
      "name": "Utah LIR Parcels",
      "steward": "UGRC + counties",
      "geometry_type": "Polygon",
      "last_edit_date": "2024-03-15",
      "max_record_count": 2000,
      "useful_fields": [
        "PARCEL_ID",
        "COUNTY_NAME",
        "PARCEL_ACRES",
        "PROP_CLASS",
        "OWN_TYPE",
        "TOTAL_MKT_VALUE"
      ],
      "gaps": ["No owner names — those are county-held."],
      "caveats": ["Coverage is best-effort; check per-parcel asof date."]
    },
    {
      "org": "ugrc",
      "layer": "parcels_basic",
      "name": "Utah Basic Parcels",
      "steward": "UGRC + counties",
      "geometry_type": "Polygon",
      "last_edit_date": "2024-02-04",
      "max_record_count": 2000,
      "useful_fields": ["PARCEL_ID", "COUNTY_NAME"],
      "gaps": [],
      "caveats": []
    }
  ]
}
```

### `findLayer({ query: "springs" })` return

```json
{
  "query": "springs",
  "capped_at": 50,
  "total_returned": 3,
  "results": [
    {
      "name": "Utah Springs NHD",
      "description": "National Hydrography Dataset springs for Utah, sourced from USGS NHD High-Resolution. Includes ~12,000 mapped springs statewide.",
      "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/SpringsNHDHigh/FeatureServer/0",
      "last_edit_date": "2023-11-02",
      "snippet": "National Hydrography Dataset springs for Utah…",
      "type": "Feature Service"
    },
    {
      "name": "Utah Water-Related Land Use - Springs subset",
      "description": "…",
      "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/WRLUSprings/FeatureServer/0",
      "last_edit_date": "2024-05-12",
      "snippet": "…",
      "type": "Feature Service"
    }
  ]
}
```

## Functional requirements

| ID | Requirement |
| --- | --- |
| **F4** | One `list_<category>` discovery tool per SGID category with ≥1 Tier 1 layer (20 tools). Each takes no params; returns full per-layer catalog including `last_edit_date`, `useful_fields`, `gaps`, `caveats`. |
| **F5** | `find_layer({ query, limit? })` searches UGRC's full Hub catalog live, returning `{ name, description, url, last_edit_date, snippet, type }` ready to feed into `arcgis_query({ url, ... })`. |
| **F12** | Every `list_<category>` tool description ends with "Pair with `arcgis_query` / `arcgis_aggregate` to pull data" and the `find_layer` fallback nudge. |
| **F13** | Category-level gaps (e.g. cadastre's "NOT owner names — county-held") appear inline in both tool description and catalog return. |

## Non-functional requirements

- **N3** — `find_layer` results capped at 50 entries (zod `.max(50)` on `limit`, plus a hard server-side clamp before issuing the Hub request) to sidestep Hub's `numberMatched` reliability issues (plan.md risk #8).
- **Catalog payload size (risk #4)** — cadastre returns 64 layer entries (~30KB JSON). Acceptable; flag if any client truncates during the verification step. Don't pre-emptively paginate or summarize — the catalog is the value-add.

## Acceptance criteria

1. `npm run typecheck` passes.
2. The factory produces **exactly 20** `list_<category>` tools given the Story 1 registry — count via a quick test invocation that calls `registerSgidTools` against a stub `McpServer` and asserts the registered tool count, or by inspecting the MCP Inspector tool list after Story 5 lands.
3. Calling `list_cadastre()` returns a catalog whose `category_gaps` field literally contains the substring `"NOT owner names"` (case-sensitive substring match is fine).
4. The emitted `list_cadastre` tool description also contains the substring `"NOT owner names"` (the F13 inline-in-description requirement).
5. Every emitted `list_<category>` description ends with the substring `"try `find_layer({ query })`."`.
6. Calling `findLayer({ query: "springs" })` against the live Hub returns at least one result whose `url` field is a valid `…/FeatureServer/0` URL that `arcgis_query({ url, ... })` can consume without modification.
7. Result list is capped at 50: `findLayer({ query: "parcel", limit: 100 })` either errors at the schema layer (preferred) or returns at most 50 results.

## Verification steps

1. `npm run typecheck` — must pass.
2. **Factory smoke test:** stand up a stub `McpServer`, call `registerSgidTools(stub)`, assert exactly 20 tools registered with names matching `/^list_[a-z_]+$/`. Same for `registerHubSearchTool` (1 tool, name `find_layer`).
3. **MCP Inspector (after Story 5 wires it up — defer this step but document it here for the cutover):** confirm `list_cadastre`, `list_water`, `list_farming`, `list_cadastre` description text rendering, and `find_layer({ query: "springs" })` end-to-end.
4. **Live Hub call:** unit-style invocation of `findLayer({ query: "springs" })` against `hub.arcgis.com` (network required). Verify ≥1 result, valid URL shape, `last_edit_date` populated.
5. **Catalog payload sanity check:** invoke `list_cadastre()` programmatically; JSON-stringify the result and confirm size is ≲50KB. If any MCP client truncates, escalate per risk #4 — don't paginate without a follow-up decision.

## Risks & mitigations

- **R4 — Catalog payload size.** Cadastre's 64 entries serialize to ~30KB JSON. Acceptable in v0.2; verify in the smoke test that no consumer client truncates. If a client truncates, add a `?summary=true` toggle in v0.3 rather than altering the default shape now.
- **R7 — Hub Search hard dependency.** `find_layer` has no local cache; every call hits `hub.arcgis.com` live. Accepted per plan.md: if ArcGIS is down, the whole MCP is unusable, so caching Hub specifically buys nothing. Surface clear errors on Hub 5xx using the same retry/backoff as the v0.1 ArcGIS wrapper.
- **R8 — Hub `numberMatched` reliability.** Hub sometimes returns `numberMatched` only on first page. Cap `find_layer` at 50 results in v0.2 (N3) and don't paginate — model can refine the query if it wants more.

## Notes / references

- `docs/plan.md` §"Coverage tiers", §"Discovery model", §"Architecture", §"Tool surface" → "Discovery: SGID per-category (20 tools)" + "Generic discovery + search (3 tools)", §"Data pipeline" → "Hub Search source (Tier 2)", §"Phases" → Phase 3, §"Risks" #4 / #7 / #8.
- `docs/epic-v0.2.md` §"Functional requirements" F4, F5, F12, F13; §"Non-functional requirements" N3; §"Stories" row S3; §"Epic-level acceptance criteria" A4 (the Stratos test — F13's downstream regression) and A5 (the `find_layer` long-tail test).
- `src/mcp.ts` — v0.1's `this.server.tool(name, description, schema, handler)` registration pattern + the `text(...)` JSON-content helper to mirror.
- `src/arcgis.ts` — the `AbortSignal.timeout(30_000)` + 5xx retry/backoff pattern `find_layer` should reuse for the Hub request (extracting to `src/arcgis-client.ts` happens in Story 2; coordinate or mirror as needed).
- `CLAUDE.md` — native `fetch` only, no axios/httpx; ArcGIS-200-with-error detection isn't relevant for Hub Search (Hub returns standard HTTP error codes) but the retry shape transfers cleanly.
