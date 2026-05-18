# ugrc-mcp v0.2 — expansion plan

Status: design doc, not yet implemented. v0.1 (the current `main`) ships 5 generic tools wrapping a 7-layer hand-curated registry. This document describes how v0.2 expands to ~40 tools covering 215+ SGID layers and the full UGRC Web API, with a clean split between **discovery** (per-category catalog tools) and **action** (first-class query primitives that take `{ org, layer }` template values, not URLs).

---

## The problem

The v0.1 tools (`list_layers`, `describe_layer`, `query_layer`, `aggregate_layer`, `arcgis_query_raw`) are correct but too abstract. Connected LLM agents repeatedly write Python scripts to hit ArcGIS REST endpoints directly instead of calling the existing tools. Even when explicitly pointed to `arcgis_query_raw`, they often fail to use it on the next turn.

**Diagnosis:** LLM tool selection is dominated by matching user intent against tool names and descriptions. `query_layer` matches no specific intent; `list_water` matches *"how much irrigated farmland is in the Bear River basin?"* via "water" → basin → irrigation. The fix is more, narrower, well-named discovery tools — paired with first-class query primitives.

**Sharper framing:** LLMs already know ArcGIS REST cold — they've been trained on it. What they don't know is what URLs exist, what's fresh, what's missing, what's deliberately *not* in a layer. The MCP's job is **the catalog**; querying is commodity. v0.2 reflects that split.

---

## Design principles

1. **Discovery is the value-add. Querying is commodity.** Tools that only wrap querying add little. v0.2 separates the two: ~28 `list_<category>` tools return rich per-layer catalogs; one `arcgis_query` primitive performs reads against any cataloged layer.
2. **Concrete beats abstract.** `list_cadastre` will be picked over `list_layers` ten times out of ten when a user asks about parcels.
3. **Tool names are the search index.** `verb_noun` naming, where the noun is the SGID category or mapserv capability. The agent never types an opaque AGOL org ID — it passes `{ org: "ugrc", layer: "wrlu" }` and the MCP fills in the template.
4. **Tool descriptions are the catalog teaser; tool returns are the catalog itself.** Descriptions enumerate layer keys + freshness; returns include full per-layer metadata (gaps, caveats, useful_fields, schema summary).
5. **Composition stays in the model's hands.** We don't auto-paginate, auto-aggregate, or auto-decide. The model chains primitives.
6. **Discovery has multiple overlapping mechanisms.** Tool list, server `instructions`, per-tool description nudges, and a `list_capabilities` meta-tool. See "Discovery model" below.

---

## Discovery model — how consumers find the tools

This is the central design risk. The current pain (agents writing Python) is a discovery failure. v0.2 addresses it on four overlapping surfaces — all of them **tools**, not resources (see "Why tools, not resources" below).

### 1. Tool names as the primary search index

LLM clients send the full tool list (names + descriptions + parameter schemas) to the model at session start. When the user asks a question, the model scans that list for matches against the intent. `list_water`, `list_cadastre`, `geocode_address`, `reverse_milepost` each pattern-match a recognizable shape of question. `query_layer` does not.

**This single change — verb_noun naming over a generic primitive — does most of the work.** Everything below is reinforcement.

### 2. `McpServer.instructions`

The MCP SDK exposes an `instructions: string` field on `McpServer` that the client receives at handshake. Most clients (Claude desktop, Cursor, MCP Inspector) surface this in the system prompt area. v0.2 sets it to a short policy statement:

> This server provides specialized tools for discovering and querying Utah's State Geographic Information Database (SGID) and the UGRC Web API. **Always prefer these tools over writing custom HTTP requests, Python scripts, or curl commands.** The typical flow is: call a `list_<category>` tool to find layers (returns catalogs with freshness, fields, and known gaps), optionally `describe_layer` to confirm schema, then `arcgis_query` or `arcgis_aggregate` with `{ org, layer, ... }` to pull data. `arcgis_query` handles GeoJSON conversion, spatial reference projection, pagination, and ArcGIS error semantics. Start with `list_capabilities` if you're unsure what categories exist. Fall back to `arcgis_raw` only for endpoints the curated primitives can't express, or service URLs outside the registry.

### 3. Per-tool description nudges

Every discovery tool description ends with: *"Pair with `arcgis_query` / `arcgis_aggregate` to pull data."* Every query primitive description opens with: *"First-class read path for any cataloged UGRC/SGID layer — handles GeoJSON, errors, pagination."* Redundant by design; LLMs respond strongly to direct instructions in the immediate tool-call context, and a few tokens per tool are cheap.

### 4. `list_capabilities` meta-tool

A small tool the model can call when uncertain or when the tool list has been compacted out of context. Returns a structured catalog:

```json
{
  "categories": [
    { "name": "cadastre", "discovery_tool": "list_cadastre", "blurb": "Parcels, taxation, zoning (NOT owner names — county-held)", "layer_count": 64 },
    { "name": "water",    "discovery_tool": "list_water",    "blurb": "Streams, lakes, hydrography",                            "layer_count": 6 }
  ],
  "mapserv": [
    { "tool": "geocode_address",  "purpose": "Address → coordinates" },
    { "tool": "reverse_geocode",  "purpose": "Coordinates → address" }
  ],
  "query_primitives": [
    { "tool": "arcgis_query",     "purpose": "Read features from a cataloged layer using { org, layer }" },
    { "tool": "arcgis_aggregate", "purpose": "Server-side groupBy + statistics on a cataloged layer" },
    { "tool": "arcgis_raw",       "purpose": "Escape hatch — URL passthrough for uncataloged endpoints" }
  ],
  "registered_orgs": ["ugrc"]
}
```

### Why tools, not resources

MCP exposes three primitives: **tools** (model-driven), **resources** (passive, client-driven), and **prompts** (user-invoked). v0.2 uses only tools for discovery, by design:

- **Tools** are pulled by the model mid-conversation based on intent matching. That's exactly the discovery flow we want.
- **Resources** are pulled by the *client* — typically only when the user explicitly attaches one. Claude Desktop in particular doesn't autonomously consume MCP resources; the user has to add them to the conversation, which is friction we want to eliminate.

A future version may add a parallel resource surface (e.g., `sgid://catalog`, `sgid://layer/ugrc/wrlu`) for clients with auto-attach capability — bonus path, never load-bearing.

### Failure modes we still expect

- **Forgetting tools exist after long conversations.** Some clients drop the tool list during compression. `instructions` and `list_capabilities` are short enough that the model can re-orient quickly.
- **Picking the wrong category.** "Irrigated land" lives in `farming` (the WRLU layer), not `water`. Per-tool catalog returns list specific layer names with one-line blurbs; cross-category `describe_layer` calls remain cheap.
- **Defaulting to Python for novel queries.** When an analysis pattern feels unfamiliar (complex multi-layer joins, attachments, etc.), models reach for code. `arcgis_raw` exists explicitly as the safety net.

The acceptance tests below validate that these mechanisms are working.

---

## Architecture

```
src/
  registry/
    sgid.ts            # generated from agrc/sgid-index — 28 categories × N layers, with per-layer metadata
    orgs.ts            # hand-maintained — org handle → opaque AGOL ID mapping (e.g., ugrc → "99lidPhWCzftIe9K")
    mapserv.ts         # hand-written — the 7 mapserv endpoints
  tools/
    sgid.ts            # factory that emits ~28 list_<category> tools
    arcgis.ts          # arcgis_query, arcgis_aggregate, arcgis_raw — first-class query primitives
    mapserv.ts         # 7 mapserv tools
    generic.ts         # describe_layer, list_capabilities
  arcgis-client.ts     # internal HTTP wrapper + ArcGIS protocol details (renamed from arcgis.ts)
  geometry.ts          # unchanged — GeoJSON ↔ esriJSON conversion
  mcp.ts               # wires it all together, sets server instructions
  index.ts             # unchanged
scripts/
  sync-sgid-registry.ts   # one-shot fetch + transform, run manually
  enrichment.ts           # hand-maintained per-layer gaps, caveats, useful_fields overrides
docs/
  plan.md            # this file
```

---

## The `ORGS` registry

The opaque AGOL org IDs (`services1.arcgis.com/<16-char-random>/...`) are the worst part of ArcGIS Online — there's no directory mapping orgs to jurisdictions, and asking an agent to transcribe them is asking for hallucinations.

`src/registry/orgs.ts` is the answer: a hand-maintained mapping from human-readable handles to opaque IDs:

```ts
export const ORGS = {
  ugrc: {
    name: "Utah Geospatial Resource Center (SGID)",
    agol_id: "99lidPhWCzftIe9K",
    url_base: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services",
  },
  // v0.3 adds: beco (Box Elder County), slco (Salt Lake County), blm_utah, ...
} as const;
```

v0.2 ships with just `ugrc`. The schema is forward-compatible: v0.3's federation work is "add more entries here, register their layers in the relevant category." The query API surface doesn't change.

---

## Data pipeline

### Upstream source

The canonical SGID layer catalog lives in a private Google Sheet (`SGID Index`) curated by UGRC. It's mirrored to a public GitHub repo at https://github.com/agrc/sgid-index, specifically the file `src/data/downloadMetadata.ts`. ~380 entries grouped by an `openSgid` category prefix (e.g., `cadastre.parcels`, `water.streams`, `transportation.roads`).

Of the ~380 entries:
- ~215 have an `openSgid` category and a usable AGOL FeatureServer URL within a known org — these become our registry.
- ~165 are hosted externally, lack a `openSgid` prefix, or have no queryable service. We drop them and document the gap. They remain accessible via `arcgis_raw` if their URL is known.

### What goes into the registry

Each layer entry combines three sources:

**1. From upstream (`downloadMetadata.ts`):**
- `org` — the org handle (always `"ugrc"` in v0.2; v0.3 adds counties/federal).
- `layer` — short key unique within the org (e.g., `"wrlu"`, `"parcels_lir"`).
- `name` — display name.
- `steward` — the UGRC division or partner agency that owns the data.
- category assignment (`openSgid` prefix).

**2. From the layer's own ArcGIS REST `?f=pjson` response (auto-extracted at sync time):**
- `service_path` — the path under the org's `url_base` (e.g., `WaterRelatedLandUse/FeatureServer/0`). The MCP joins `ORGS[org].url_base + "/" + service_path` to get the full URL.
- `last_edit_date` — from `editingInfo.dataLastEditDate`. The single most important piece of freshness metadata; surfaced verbatim in tool descriptions.
- `geometry_type` — Polygon, Point, etc.
- `max_record_count` — usually 2000; informs pagination hints.
- `extent` — bounding box of the data.
- `field_summary` — just names + types (~50 bytes per field). Full schema with domain values stays out of the registry; `describe_layer` re-fetches it on demand.

**3. From hand-curated `scripts/enrichment.ts` (sidecar file):**
- `useful_fields` — the subset of fields a model should typically request, ordered by usefulness.
- `gaps` — what this layer does **not** have, with pointers. Example: `parcels_lir.gaps = ["No owner names — those are county-level data, not in SGID. v0.3 will surface county portals; for now, the model should call arcgis_raw against the relevant county AGOL org."]`
- `caveats` — known gotchas. Example: `wrlu.caveats = ["LUID is NOT stable across SURV_YEARs; filter by SURV_YEAR for time-series queries."]`
- `time_field` — for temporal layers (WRLU's `SURV_YEAR`, parcels' assessment year, etc.).

The enrichment file is the durable home for "things we've learned the hard way about this layer." It's how `list_cadastre`'s output can flag *"NOT owner names; those are county-held"* — that fact lives in `enrichment.ts`, gets pulled into `gaps`, and bubbles up to both the tool description and the catalog return.

### Sync flow

```
$ npm run sync-sgid-registry
  ↓
  scripts/sync-sgid-registry.ts
  ↓
  GET https://raw.githubusercontent.com/agrc/sgid-index/main/src/data/downloadMetadata.ts
  ↓
  parse TS module (regex + assertions — the file is data-only, no logic)
  ↓
  filter: drop entries without (openSgid prefix && AGOL FeatureServer URL within a known org)
  ↓
  for each surviving layer, GET <url>?f=pjson  (parallel, batched, retry on 5xx)
    → extract last_edit_date, geometry_type, max_record_count, extent, field_summary
  ↓
  merge in hand-curated overrides from scripts/enrichment.ts
    → useful_fields, gaps, caveats, time_field
  ↓
  group by category prefix
  ↓
  write src/registry/sgid.ts
  ↓
  git diff — review, commit, deploy
```

The pjson step adds ~30–60s to sync time (215 layers × ~200ms with batching). Failures on individual layers are logged but non-fatal — the layer keeps its upstream metadata and `last_edit_date: null`. Hand-running the script and reviewing the diff catches anything weird.

The output is committed to the repo. This keeps deploys reproducible and offline-safe — a deploy at time T behaves identically at time T+1 day even if upstream changes.

### Sync cadence

Manual for v0.2. UGRC updates the index irregularly (months, not days). Re-run when:
- A referenced layer 404s (UGRC has historically renamed services without notice — see CLAUDE.md).
- As a quarterly habit during normal maintenance.
- Before tagging a release.

If drift becomes a regular problem, automate with a scheduled GitHub Action that opens a PR weekly.

### Why not fetch at runtime?

- **Cold-start latency:** the Worker would block on an HTTP call to GitHub before answering any tool call.
- **Reproducibility:** a deploy should behave deterministically; runtime fetches couple our behavior to upstream availability.
- **Outbound budget:** Cloudflare Workers have an outbound subrequest budget per invocation. Spending one on registry sync is wasteful.
- **Diff visibility:** committed registries surface upstream changes in PR review. Runtime fetches hide them.

---

## Tool surface

Two clean classes of tools: **discovery** (catalog browsers + schema) and **action** (query primitives + geocoding). The split is the whole architecture.

### Discovery: SGID per-category (~28 tools)

One `list_<category>` per SGID category. Initial categories (from agrc/sgid-index):

`address`, `aerial-photography`, `base-maps`, `bioscience`, `boundaries`, `cadastre`, `climate`, `demographic`, `economy`, `elevation`, `energy`, `environment`, `farming`, `geoscience`, `health`, `history`, `indices`, `location`, `planning`, `political`, `recreation`, `society`, `topo`, `transportation`, `utilities`, `water`.

Each tool takes **no parameters**. Returns the category's full catalog:

```json
{
  "category": "cadastre",
  "blurb": "Parcels, taxation, zoning",
  "category_gaps": "Owner names are NOT in SGID — they're county-held. Query the relevant county portal directly (v0.3 will register counties).",
  "layers": [
    {
      "org": "ugrc",
      "layer": "parcels_lir",
      "name": "Utah LIR Parcels",
      "steward": "UGRC + counties",
      "geometry_type": "Polygon",
      "last_edit_date": "2024-03-15",
      "max_record_count": 2000,
      "useful_fields": ["PARCEL_ID", "COUNTY_NAME", "PARCEL_ACRES", "PROP_CLASS", "OWN_TYPE", "TOTAL_MKT_VALUE"],
      "gaps": ["No owner names — those are county-held."],
      "caveats": ["Coverage is best-effort; check per-parcel asof date."]
    }
  ]
}
```

Description template (compact — there are 28 of these, so each must fit):

> Discover Utah {DisplayName} layers — {Blurb}. {Category-level gaps inline.} Returns a catalog with per-layer freshness, fields, and known gaps. Pair with `arcgis_query` / `arcgis_aggregate` to pull data. Layers ({count}): {comma-separated keys}.

Concrete example for cadastre:

> Discover Utah Cadastre layers — parcels, taxation, zoning. **NOT owner names — those are county-held, not in SGID.** Returns a catalog with per-layer freshness, fields, and known gaps. Pair with `arcgis_query` / `arcgis_aggregate` to pull data. Layers (64): `parcels_lir`, `parcels_basic`, `tax_districts`, `municipal_boundaries`, …

Two signals doing work here:
1. **Category-level gap inline** — the model sees *"NOT owner names"* before it commits to calling the tool. This is the fix for the Stratos-style failure mode.
2. **Per-layer freshness in the return payload** — the catalog response includes `last_edit_date` so the model can judge fitness without a separate `describe_layer` call for simple queries.

### Generic discovery + meta (2 tools)

| Tool | Purpose |
| --- | --- |
| `list_capabilities` | Overview: returns category names, `list_<category>` tool names, blurbs, layer counts, and registered orgs. The model's "what's available here?" entry point. |
| `describe_layer` | Full schema for any cataloged layer (`{ org, layer }`): fields with coded-value domains, current `last_edit_date` (re-fetched live), extent, plus hand-curated `gaps` and `caveats` from the registry. Use after `list_<category>` to confirm freshness and learn quirks before querying. |

### Action: query primitives (3 tools)

| Tool | Purpose |
| --- | --- |
| `arcgis_query` | **First-class read primitive.** Takes `{ org, layer, where, geometry, bbox, spatial_relationship, out_fields, return_geometry, order_by, limit, offset, distinct }`. The MCP constructs the URL from `ORGS[org].url_base` + the layer's `service_path` — the agent never sees the opaque AGOL ID. GeoJSON in/out, WGS84. Returns features in v0.1's clean shape with `exceeded_transfer_limit` + `next_offset`. **Use this for any read against cataloged UGRC/SGID layers.** |
| `arcgis_aggregate` | Server-side `groupBy` + `outStatistics`. Same `{ org, layer, ... }` shape. Reach for it before paging features for headline numbers. |
| `arcgis_raw` | Escape hatch — takes a full `url` + raw `params`. For endpoints `arcgis_query` can't express (e.g., `queryAttachments`, multipoint geometries), services outside the registry (county data, federal services), or one-off ArcGIS features. |

The model's typical flow after seeing the tool list:

1. Tool list reveals `list_cadastre` matches *"parcels in Box Elder."*
2. `list_cadastre()` → returns the catalog. Model sees `parcels_lir` exists, was edited 2024-03-15, has no owner names.
3. Optionally `describe_layer({ org: "ugrc", layer: "parcels_lir" })` to confirm specific fields and domain values.
4. `arcgis_query({ org: "ugrc", layer: "parcels_lir", geometry: <stratos polygon>, out_fields: ["PARCEL_ID", "COUNTY_NAME", "PARCEL_ACRES"] })` → features.

If the user needed owner names, step 2 surfaces the gap before the model commits to a useless query.

### mapserv (7 tools)

Hand-written wrappers over https://api.mapserv.utah.gov/docs/.

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `geocode_address` | `/api/v1/geocode/{street}/{zone}` | Address → coordinates |
| `geocode_milepost` | `/api/v1/geocode/milepost/{route}/{milepost}` | UDOT route + milepost → coordinates |
| `reverse_geocode` | `/api/v1/geocode/reverse/{x}/{y}` | Coordinates → address |
| `reverse_milepost` | `/api/v1/geocode/milepost/{x}/{y}` | Coordinates → UDOT route + milepost |
| `search_sgid_via_mapserv` | `/api/v1/search/{table}/{fields}` | Mapserv's SQL-like search (kept for query shapes AGOL `/query` can't express 1:1) |
| `list_sgid_tables` | `/api/v1/info/featureClassNames` | Enumerate mapserv-known table names |
| `list_sgid_fields` | `/api/v1/info/fieldnames/{tableName}` | Enumerate columns of a table |

All seven default `spatialReference=4326` in our wrapper (mapserv's native default is UTM 12N — annoying for an LLM). All seven require `UGRC_API_KEY` as a Worker secret. If unset, each tool returns a clear error:

> Set UGRC_API_KEY via `wrangler secret put UGRC_API_KEY`. Request a key at developer.mapserv.utah.gov.

**Total tool count: ~28 (`list_<category>`) + 2 (generic) + 3 (action) + 7 (mapserv) = 40.**

---

## Phases

### Phase 1 — Registries

- Hand-write `src/registry/orgs.ts` with the single v0.2 entry: `ugrc → "99lidPhWCzftIe9K"`. Schema set up for v0.3 to add counties.
- Write `scripts/sync-sgid-registry.ts` and `scripts/enrichment.ts`.
- Run sync. Commit `src/registry/sgid.ts`.
- Fold v0.1's 7 hand-curated layers into the appropriate categories with their enrichment notes (gaps, caveats).
- Remove `src/registry.ts`.

### Phase 2 — Query primitives (first-class)

- Promote v0.1's `query_layer` / `aggregate_layer` / `arcgis_query_raw` into the new `src/tools/arcgis.ts` as `arcgis_query` / `arcgis_aggregate` / `arcgis_raw`.
- Rewrite to take `{ org, layer, ... }` instead of `{ layer | url, ... }`. URL resolution goes through `ORGS` + `SGID_CATEGORIES`.
- `arcgis_raw` stays URL-based for true escape-hatch use.
- Rename `src/arcgis.ts` → `src/arcgis-client.ts` (internal HTTP/protocol layer).
- Tool descriptions framed as "the curated read path for cataloged UGRC/SGID layers" — not "last resort."

### Phase 3 — SGID discovery tools

- Build the factory in `src/tools/sgid.ts` that emits one `list_<category>` per registry category.
- Each tool returns the full catalog (per-layer freshness, useful_fields, gaps, caveats).
- Update `mcp.ts` to register everything.
- Verify the tool list renders correctly in MCP Inspector.

### Phase 4 — mapserv tools + API key

- Add `UGRC_API_KEY` to `Env` (regenerates from `wrangler.jsonc` via `npm run cf-typegen`).
- Write the 7 tools in `src/tools/mapserv.ts`.
- Document `wrangler secret put UGRC_API_KEY` in README.

### Phase 5 — Discovery polish

- Set `instructions` on the `McpServer`.
- Implement `list_capabilities` in `src/tools/generic.ts`.
- Implement `describe_layer` in `src/tools/generic.ts` (uses cataloged metadata + live pjson fetch).
- Append the "Pair with `arcgis_query` to pull features" sentence to every `list_<category>` description.

### Phase 6 — Docs + cutover

- Update README tool table.
- Update CLAUDE.md architecture section.
- Tag v0.2.

---

## Risks

1. **`downloadMetadata.ts` upstream stability.** If agrc renames or moves the file, sync fails loudly (good). Pin a known-good commit SHA in the sync script and bump manually.
2. **No documented rate limit on mapserv.** If hosted-instance abuse becomes a problem, add a Cloudflare WAF rule or move behind Cloudflare Access. README already nudges heavy users to self-deploy.
3. **Tool list token cost.** ~40 tools × ~200 tokens each ≈ 8K tokens of tool metadata on every session. Real but acceptable — trade for dramatically better tool-selection behavior. Measure after Phase 5 ships.
4. **Large catalog returns.** Cadastre's `list_cadastre` returns 64 layer entries with metadata. Estimate ~30KB of JSON per call. Fine for the model to process; flag if any client truncates.
5. **SGID layer URL drift.** UGRC has historically renamed services. The sync script can't catch this — it only sees what upstream advertises. Mitigation: when a tool call 404s, the error surfaces the `{ org, layer }` key, making it easy to either fix the registry or fall back to `arcgis_raw`.
6. **`arcgis_query` discoverability.** The whole pivot hinges on the model reaching for `arcgis_query` after a `list_<category>` call. If the description doesn't sell that pairing clearly, the model may revert to writing Python anyway. The acceptance tests below are the regression bar.

---

## Out of scope for v0.2

v0.2 is scoped tightly to **state-level data** so we can validate the discovery model on a coherent dataset before expanding. Deferred to v0.3+:

- **Federation across jurisdictions.** Utah GIS is federated: state (us), 29 counties, federal (BLM, USFS, etc.), tribal, utilities. v0.2 wraps only state SGID — only `ugrc` is registered in `ORGS`. The MCP must be **honest about this gap** — when a query needs county-held data (owner names being the canonical example), the relevant tool's `category_gaps` field points to "v0.3 will surface county portals; for now, use `arcgis_raw` against the county AGOL org if you know the URL."
- **County GIS portals.** No `utah_gis_directory` tool, no curated county registry, no county-level convenience tools, no additional `ORGS` entries.
- **Generic ArcGIS server discovery.** No `discover_arcgis_server` tool. ArcGIS Online's `services.arcgis.com/<opaque-org-id>` pattern is genuinely uncrawlable without a curated jumping-off list — that list, and the tool that uses it, is v0.3 work.
- **MCP resources.** Most clients (Claude Desktop especially) don't autonomously consume resources — users have to attach them manually. v0.2 ships discovery as tools only. A future version may add a parallel resource surface (`sgid://catalog`, `sgid://layer/ugrc/wrlu`) for clients with auto-attach; never load-bearing.
- **Live registry refresh.** No scheduled GitHub Action to keep the registry in sync. Manual `npm run sync-sgid-registry` is the v0.2 cadence.
- **Cross-layer joins or chained-query helpers.** The model composes; we don't.

## Acceptance criteria

A fresh agent with no prompting beyond the MCP connection should:

1. Answer *"how many acres of irrigated alfalfa in Utah in 2023?"* by calling `list_farming` → `arcgis_aggregate({ org: "ugrc", layer: "wrlu", ... })` — **not** by writing Python.
2. Answer *"what's the street address at 40.7608° N, 111.8910° W?"* by calling `reverse_geocode` — **not** by writing curl.
3. Answer *"which parcels overlap this polygon?"* by calling `list_cadastre` → `arcgis_query({ org: "ugrc", layer: "parcels_lir", geometry: {...} })` — **not** by composing a manual ArcGIS REST URL.
4. **The Stratos test.** Answer *"who owns the parcels inside this polygon?"* (with a Box Elder County polygon) by calling `list_cadastre`, **reading the `category_gaps` field stating that owner names are NOT in SGID**, explaining the limitation to the user, and recommending the v0.3 county-portal path (or falling back to `arcgis_raw` against `beco.maps.arcgis.com` if the agent knows the URL). The agent must **not** hallucinate that LIR contains owners and must **not** silently fail.

If any of those four conversations fail the same way they currently do, the discovery story needs more work before tagging v0.2. #4 is the canonical regression test for the original pain.
