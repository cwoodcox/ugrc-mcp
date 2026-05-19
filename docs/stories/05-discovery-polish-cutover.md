# Story 5 — Discovery polish, wire-up, cutover

**One-liner:** Wire S1–S4 into `mcp.ts`, ship the two remaining generic meta-tools (`list_capabilities`, `describe_layer`), set `McpServer.instructions`, gut every v0.1 leftover, bump to `0.2.0`, and validate the five acceptance conversations from plan.md end-to-end.

## Goal

This is the cutover. S1 built the registry, S2 promoted the query primitives, S3 emitted the SGID discovery factory + `find_layer`, S4 added mapserv — none of them touched `mcp.ts`. Story 5 is where the 33-tool surface actually appears to a connected agent. The work is small in code volume but load-bearing: every registration function from S2/S3/S4 gets called, the two generic meta-tools are written, `instructions` is set so the handshake sells the policy, descriptions are verified to end with the pairing nudge, and the v0.1 layer registry + 5-tool inline `mcp.ts` is removed. The polish here — `instructions`, `list_capabilities`, the description nudges — is what pushes acceptance #4 (Stratos / honest gaps) and #5 (springs / Tier 2 long-tail) over the line. If the model still writes Python after handshake, that failure shows up first in those two conversations.

## What this story IS

- Implement `list_capabilities` in `src/tools/generic.ts` returning the three-tier overview structure from plan.md §"`list_capabilities` meta-tool".
- Rewrite `describe_layer` in `src/tools/generic.ts` to accept `{ org, layer } | { url }`; merges S1's cataloged metadata + live `?f=pjson` re-fetch for current `last_edit_date`; preserves the v0.1 per-isolate `Map` cache (lifted out of `src/arcgis.ts`).
- Set `McpServer.instructions` to the policy paragraph from plan.md §"`McpServer.instructions`", verbatim.
- Gut `src/mcp.ts` and rewrite it to call the registration functions from S2/S3/S4 + a new `registerGenericTools(server)` for the two meta-tools above.
- Verify every `list_<category>` tool description ends with the pairing nudge sentence (template owned by S3; S5 only spot-checks).
- Delete `src/registry.ts` (replaced by S1's `src/registry/sgid.ts`).
- Delete the five v0.1 inline tool definitions from `src/mcp.ts` (replaced by the registration functions).
- Confirm `src/arcgis.ts` got renamed to `src/arcgis-client.ts` in S2 — if S2 didn't do it, finish the rename here.
- Bump `package.json` `version` → `0.2.0`.
- Create `README.md` (if not present) with the v0.2 tool table + `wrangler secret put UGRC_API_KEY` instructions.
- Update `CLAUDE.md` — Architecture section rewritten for discovery/action split, three coverage tiers, 33-tool surface; Commands section adds `npm run sync-sgid-registry`.
- Run the five acceptance conversations from plan.md / epic AC A1–A5 in MCP Inspector against `npm run dev`.
- Measure tool-list token cost (plan.md risk #3 / epic N6) and record the number in the PR description.

## What this story IS NOT

- **NOT writing the SGID `list_<category>` factory.** That's S3. S5 only calls `registerSgidTools(server)`.
- **NOT writing `find_layer`.** That's S3. S5 only calls `registerHubSearch(server)`.
- **NOT writing `arcgis_query` / `arcgis_aggregate` / `arcgis_raw`.** That's S2. S5 only calls `registerArcgisTools(server)`.
- **NOT writing the 7 mapserv tools.** That's S4. S5 only calls `registerMapservTools(server)`.
- **NOT touching `src/registry/sgid.ts` or `src/registry/orgs.ts`.** That's S1.
- **NOT adding new layers, new categories, new orgs, or any new tool beyond the two generic meta-tools.**
- **NOT changing tool descriptions written by S2/S3/S4** — only verifying the discovery-tool descriptions end with the pairing nudge. If one doesn't, that's an S3 bug to file, not an S5 fix.
- **NOT scheduling registry sync** (still manual per plan.md §"Sync cadence").
- **NOT touching `src/geometry.ts` or `src/index.ts`** — both unchanged from v0.1.

## Dependencies

- **Depends on:** **S1, S2, S3, AND S4.** This is the only true serialization point in the epic — the critical-path diamond's join.
  - S1 ships `src/registry/{types,orgs,sgid}.ts` (consumed by `list_capabilities` and `describe_layer`).
  - S2 ships `registerArcgisTools` from `src/tools/arcgis.ts` and the `arcgis-client.ts` rename.
  - S3 ships `registerSgidTools` from `src/tools/sgid.ts` and `registerHubSearch` from `src/tools/hub-search.ts`.
  - S4 ships `registerMapservTools` from `src/tools/mapserv.ts` and the `UGRC_API_KEY` binding in `wrangler.jsonc`.
- **Unblocks:** the v0.2 tag.
- **Parallel with:** nothing — S5 is strictly last.

## Files created

| Path | Purpose |
| --- | --- |
| `src/tools/generic.ts` | Exports `describeLayer`, `listCapabilities`, and a `registerGenericTools(server: McpServer)` registration function. Owns the per-isolate `Map` cache lifted from v0.1's `src/arcgis.ts`. |
| `README.md` *(if not already present)* | v0.2 tool table (33 rows, grouped by discovery / action / mapserv / generic), the `wrangler secret put UGRC_API_KEY` instruction, link back to `docs/plan.md` for design rationale. |

## Files edited

| Path | Change |
| --- | --- |
| `src/mcp.ts` | Gutted. New body: import the five registration functions, construct `McpServer({ name, version: "0.2.0", instructions: INSTRUCTIONS })`, call each `register*(server)` in order, drop the v0.1 tool definitions. |
| `CLAUDE.md` | Architecture section rewritten for the discovery/action split, three coverage tiers, and the 33-tool surface. Stack layout line updated to the new file tree. Out-of-scope and Commands sections updated. |
| `package.json` | `"version": "0.1.0"` → `"0.2.0"`. |

## Files deleted

| Path | Reason |
| --- | --- |
| `src/registry.ts` | v0.1's 7-layer hand registry. Replaced by S1's generated `src/registry/sgid.ts` + enrichment. The v0.1 facts (`useful_fields`, `notes`, `id_field`) were carried into `scripts/enrichment.ts` by S1 — confirm acceptance criteria #5–#7 of S1 hold before deleting. |
| v0.1 tool defs inlined in `src/mcp.ts` | Replaced by registration functions. The whole `init()` body shrinks to ~10 lines. |

## Task list

A subagent can follow this in order. Run S1–S4 verification first to confirm the foundation is sound.

### 0. Confirm S1–S4 landed

```bash
cd /Users/coreywoodcox/Developer/cwoodcox/ugrc-mcp
git log --oneline main..HEAD          # expect commits from S1, S2, S3, S4
ls src/registry/                       # types.ts, orgs.ts, sgid.ts
ls src/tools/                          # arcgis.ts, sgid.ts, hub-search.ts, mapserv.ts
ls src/arcgis-client.ts                # S2 renamed src/arcgis.ts → here
npm run typecheck                      # must pass before S5 work begins
```

If any of those are missing, stop and finish the upstream story.

### 1. `src/tools/generic.ts` — `describeLayer`

Signature accepts `{ org, layer } | { url }`. Resolution:

- `{ org, layer }` — look up the layer in S1's `SGID` by walking categories; throw `Unknown layer 'ugrc/<layer>'. Try list_capabilities to see categorized layers, or find_layer({ query }) for the long tail.` on miss. Resolve URL via S1's `ORGS` + `service_path`.
- `{ url }` — accept as-is. Strip trailing slashes (mirror v0.1's `resolveLayerUrl`).

Cache:

- Module-level `const SCHEMA_CACHE = new Map<string, unknown>();` keyed by the resolved URL. Lift verbatim from v0.1's `src/arcgis.ts` (S2 should have left it behind when it deleted the v0.1 `describeLayer`; if it didn't, port the same `Map` shape).
- The cache stores the **merged** payload (cataloged metadata + live pjson). Live `?f=pjson` is fetched once per isolate per URL.
- Per CLAUDE.md / N7: per-isolate, best-effort. Do not promote to KV / Cache API in this story.

Return shape merges:

1. Cataloged metadata from `SGID` (when `{ org, layer }` was used or when the URL matches a cataloged `service_path`): `org`, `layer`, `name`, `steward`, `useful_fields`, `gaps`, `caveats`, `time_field`, `extent` (from registry).
2. Live pjson re-fetch: current `last_edit_date` (from `editingInfo.dataLastEditDate`), `geometry_type`, `max_record_count`, full `fields[]` with `domain_values` inlined (the v0.1 shape — coded-value `name` strings), description (trimmed to 2000 chars).

Always re-fetch pjson for `last_edit_date` (the catalog's value is sync-time stale). The cache makes the re-fetch one-per-isolate.

### 2. `src/tools/generic.ts` — `listCapabilities`

No params. Returns the JSON shape verbatim from plan.md §"`list_capabilities` meta-tool":

- `tiers.{categorized,uncategorized,outside_ugrc}` — `categorized.layer_count` and `category_count` computed from `SGID`. `categorized.tool_prefix: "list_<category>"`. `uncategorized.tool: "find_layer"`, `approx_count: 528`, `source: "ArcGIS Hub live search"`. `outside_ugrc.tool: "arcgis_raw"`.
- `categories[]` — one entry per `SGID` category: `{ name, discovery_tool: "list_<name>", blurb, layer_count }`. Sorted by `layer_count` desc.
- `mapserv[]` — hand-curated list of the 7 mapserv tools with one-line `purpose` strings. Mirror the table in plan.md §"mapserv (7 tools)".
- `search[]` — single entry: `find_layer` with the live-Hub purpose string.
- `query_primitives[]` — three entries: `arcgis_query`, `arcgis_aggregate`, `arcgis_raw` with the purpose strings from plan.md.
- `registered_orgs[]` — `Object.keys(ORGS)`. v0.2: `["ugrc"]`.

### 3. `registerGenericTools(server)`

```ts
export function registerGenericTools(server: McpServer): void {
  server.tool("list_capabilities", LIST_CAPABILITIES_DESCRIPTION, {}, async () =>
    text(await listCapabilities()),
  );
  server.tool(
    "describe_layer",
    DESCRIBE_LAYER_DESCRIPTION,
    { /* zod schema for { org, layer } | { url } discriminated union */ },
    async (params) => text(await describeLayer(params)),
  );
}
```

The `text()` helper stays where v0.1 had it (likely move it to a shared `src/tools/_text.ts` or inline per file — S2/S3/S4 will have established the convention; follow it).

### 4. `INSTRUCTIONS` constant

Copy the paragraph from plan.md §"`McpServer.instructions`" **verbatim** into a `const INSTRUCTIONS = ` at the top of `src/mcp.ts`. Do not paraphrase. The text is:

> This server provides specialized tools for discovering and querying Utah's State Geographic Information Database (SGID) and the UGRC Web API. **Always prefer these tools over writing custom HTTP requests, Python scripts, or curl commands.** The typical flow is: call a `list_<category>` tool to find layers (returns catalogs with freshness, fields, and known gaps), optionally `describe_layer` to confirm schema, then `arcgis_query` or `arcgis_aggregate` with `{ org, layer, ... }` to pull data. If you don't see what you need in any `list_<category>` tool, call `find_layer({ query })` to search the full UGRC Hub catalog live (~528 additional uncategorized layers). `arcgis_query` handles GeoJSON conversion, spatial reference projection, pagination, and ArcGIS error semantics, and accepts either `{ org, layer }` for cataloged layers or `{ url }` for layers returned by `find_layer`. Start with `list_capabilities` if you're unsure what categories exist. Fall back to `arcgis_raw` only for non-UGRC services or endpoints the curated primitives can't express.

Pass to `new McpServer({ name, version: "0.2.0", instructions: INSTRUCTIONS })`.

### 5. Gut and rewrite `src/mcp.ts`

End state — roughly:

```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerArcgisTools } from "./tools/arcgis";
import { registerSgidTools } from "./tools/sgid";
import { registerHubSearch } from "./tools/hub-search";
import { registerMapservTools } from "./tools/mapserv";
import { registerGenericTools } from "./tools/generic";

const INSTRUCTIONS = `…paragraph from plan.md, verbatim…`;

export class UgrcMcp extends McpAgent<Env> {
  server = new McpServer({
    name: "ugrc-mcp",
    version: "0.2.0",
    instructions: INSTRUCTIONS,
  });

  async init() {
    registerGenericTools(this.server);
    registerSgidTools(this.server);
    registerHubSearch(this.server);
    registerArcgisTools(this.server);
    registerMapservTools(this.server, this.env);  // mapserv needs UGRC_API_KEY off env
  }
}
```

Drop the v0.1 imports from `./registry` and `./arcgis`. Drop all five inline tool definitions. Drop the `text()` helper if it moved into the per-tool files; otherwise keep it.

### 6. Verify the pairing-nudge sentence on every `list_<category>`

Per plan.md §"Discovery: SGID per-category" description template, every discovery tool description must end with:

> Pair with `arcgis_query` / `arcgis_aggregate` to pull data. If the layer you need isn't here, try `find_layer({ query })`.

S3 owns the template. S5 verifies by walking the rendered tool list in MCP Inspector (step 12 below) and grep'ing the source:

```bash
# Both substrings should appear in src/tools/sgid.ts in every tool description.
grep -c 'Pair with `arcgis_query`' src/tools/sgid.ts        # expect 1 (template lives once)
grep -c 'find_layer({ query })' src/tools/sgid.ts            # expect 1 (template lives once)
```

If S3 inlined the description per-tool instead of templating, the counts will be 20 each. Either is fine — what matters is that every rendered description ends with both sentences. If any doesn't, file a bug back to S3; don't fix in S5.

### 7. Delete `src/registry.ts`

```bash
git rm src/registry.ts
npm run typecheck    # must pass
```

If typecheck fails with imports from `./registry`, an upstream story missed something — fix at the source (S2 / S3) rather than restoring the file.

### 8. Bump version

```bash
# edit package.json: "version": "0.1.0" → "0.2.0"
```

### 9. Update `CLAUDE.md`

The Architecture section was written against the v0.1 5-tool surface. Rewrite the Architecture, Stack layout, and Commands sections to reflect:

- The discovery/action split.
- The three coverage tiers (Tier 1 categorized core, Tier 2 `find_layer`, Tier 3 `arcgis_raw`).
- The 33-tool surface (20 `list_<category>` + 3 generic/search + 3 action + 7 mapserv).
- New file layout (`src/tools/*`, `src/registry/*`, `src/arcgis-client.ts`).
- `npm run sync-sgid-registry` in Commands.
- `wrangler secret put UGRC_API_KEY` in Commands.
- Drop the named references to `list_layers`, `query_layer`, `aggregate_layer`, `arcgis_query_raw`. Keep the cross-cutting invariants (geometry I/O, ArcGIS-200-with-error, geometry-too-large hint, `spatial_relationship` translation) — those are still true.
- Update the Acceptance test section to point at plan.md §"Acceptance criteria" (A1–A5) instead of the v0.1 single alfalfa query.

### 10. Write `README.md`

If one doesn't exist (it doesn't, as of the working tree at story time), create it with:

- One-paragraph project description (pull from epic §"Why this epic").
- Tool table (33 rows) grouped by discovery / search / action / mapserv / generic.
- Quick-start: `npm install`, `wrangler secret put UGRC_API_KEY`, `npm run dev`, point MCP Inspector at `http://localhost:8787/mcp`.
- Link to `docs/plan.md` (design rationale) and `docs/epic-v0.2.md` (scope).

If a README already exists from S4 (which added the `UGRC_API_KEY` doc), extend it rather than overwriting.

### 11. Typecheck

```bash
npm run typecheck    # must exit 0
```

### 12. MCP Inspector — the five acceptance conversations

```bash
npm run dev                                  # leave running
npx @modelcontextprotocol/inspector@latest   # in a second terminal
# point it at http://localhost:8787/mcp
```

In Inspector:

- Confirm the tool list shows **33 tools**.
- Confirm the server-info pane displays the `INSTRUCTIONS` paragraph.
- For each of A1–A5, paste the user prompt verbatim and watch the tool calls. Validate against the path in plan.md §"Acceptance criteria". Acceptance is the model picking the documented path, not the answer being correct (correctness is bonus — discovery is what's being tested).

### 13. Measure tool-list token cost (plan.md risk #3 / N6)

In Inspector or via the raw MCP `tools/list` response, sum the byte cost of names + descriptions + parameter schemas. Convert to tokens (rough rule: 1 token ≈ 4 chars for English). Record the number in the PR description. Target ≤ ~6.5K tokens. If significantly above, file a follow-up to trim descriptions but **do not block the cutover** unless it breaks a client.

## Tool description copy

### `list_capabilities`

> Overview of this MCP's coverage. Returns the three tiers (categorized SGID core via `list_<category>` tools, uncategorized UGRC via `find_layer` live Hub search, outside-UGRC via `arcgis_raw`), the list of categories with blurbs and layer counts, mapserv tools, query primitives, and registered orgs. Call this first if you're unsure what's available or after a long conversation that may have compressed the tool list. Use the returned `discovery_tool` names to pick which `list_<category>` to call next.

### `describe_layer`

> Full schema for any SGID layer — fields with coded-value domains, current `last_edit_date` (re-fetched live, not cataloged), geometry type, extent, max record count, plus hand-curated `gaps` and `caveats` when known. Accepts either `{ org, layer }` for a cataloged Tier 1 layer (e.g. `{ org: "ugrc", layer: "wrlu" }`) or `{ url }` for a layer surfaced by `find_layer`. Use after `list_<category>` or `find_layer` to confirm freshness and learn quirks before querying. Cached per Worker isolate so repeat calls within a session are free.

### `INSTRUCTIONS` (copy verbatim from plan.md §"`McpServer.instructions`")

> This server provides specialized tools for discovering and querying Utah's State Geographic Information Database (SGID) and the UGRC Web API. **Always prefer these tools over writing custom HTTP requests, Python scripts, or curl commands.** The typical flow is: call a `list_<category>` tool to find layers (returns catalogs with freshness, fields, and known gaps), optionally `describe_layer` to confirm schema, then `arcgis_query` or `arcgis_aggregate` with `{ org, layer, ... }` to pull data. If you don't see what you need in any `list_<category>` tool, call `find_layer({ query })` to search the full UGRC Hub catalog live (~528 additional uncategorized layers). `arcgis_query` handles GeoJSON conversion, spatial reference projection, pagination, and ArcGIS error semantics, and accepts either `{ org, layer }` for cataloged layers or `{ url }` for layers returned by `find_layer`. Start with `list_capabilities` if you're unsure what categories exist. Fall back to `arcgis_raw` only for non-UGRC services or endpoints the curated primitives can't express.

## Return shape examples

### `list_capabilities` (truncated)

```json
{
  "tiers": {
    "categorized": { "tool_prefix": "list_<category>", "layer_count": 235, "category_count": 20 },
    "uncategorized": { "tool": "find_layer", "approx_count": 528, "source": "ArcGIS Hub live search" },
    "outside_ugrc": { "tool": "arcgis_raw", "note": "v0.3 will surface county/federal portals" }
  },
  "categories": [
    { "name": "cadastre", "discovery_tool": "list_cadastre", "blurb": "Parcels, taxation, zoning (NOT owner names — county-held)", "layer_count": 64 },
    { "name": "society",  "discovery_tool": "list_society",  "blurb": "Schools, libraries, civic facilities", "layer_count": 19 },
    { "name": "water",    "discovery_tool": "list_water",    "blurb": "Streams, lakes, hydrography",         "layer_count": 6 },
    { "name": "farming",  "discovery_tool": "list_farming",  "blurb": "Land use, irrigation, ag protection", "layer_count": 2 }
  ],
  "mapserv": [
    { "tool": "geocode_address",         "purpose": "Address → coordinates" },
    { "tool": "reverse_geocode",         "purpose": "Coordinates → address" },
    { "tool": "geocode_milepost",        "purpose": "UDOT route + milepost → coordinates" },
    { "tool": "reverse_milepost",        "purpose": "Coordinates → UDOT route + milepost" },
    { "tool": "search_sgid_via_mapserv", "purpose": "SQL-like search over mapserv-known SGID tables" },
    { "tool": "list_sgid_tables",        "purpose": "Enumerate mapserv-known table names" },
    { "tool": "list_sgid_fields",        "purpose": "Enumerate columns of a mapserv table" }
  ],
  "search": [
    { "tool": "find_layer", "purpose": "Live full-text search across UGRC's full Hub catalog (~763 Feature Services)" }
  ],
  "query_primitives": [
    { "tool": "arcgis_query",     "purpose": "Read features from a cataloged layer ({ org, layer }) or a URL from find_layer ({ url })" },
    { "tool": "arcgis_aggregate", "purpose": "Server-side groupBy + statistics on a cataloged layer or URL" },
    { "tool": "arcgis_raw",       "purpose": "Escape hatch — URL passthrough for non-UGRC endpoints or features arcgis_query doesn't model" }
  ],
  "registered_orgs": ["ugrc"]
}
```

### `describe_layer({ org: "ugrc", layer: "wrlu" })` (cataloged + live merge)

```json
{
  "org": "ugrc",
  "layer": "wrlu",
  "name": "Water Related Land Use",
  "steward": "Utah Division of Water Resources",
  "geometry_type": "esriGeometryPolygon",
  "max_record_count": 2000,
  "last_edit_date": "2025-09-04",
  "extent": { "xmin": -114.05, "ymin": 36.99, "xmax": -109.04, "ymax": 42.00, "spatialReference": { "wkid": 4326 } },
  "useful_fields": ["Landuse", "CropGroup", "Description", "IRR_Method", "Acres", "Basin", "SubArea", "SURV_YEAR"],
  "gaps": [],
  "caveats": [
    "LUID is NOT stable across SURV_YEARs — filter by SURV_YEAR for time-series queries.",
    "Landuse value is 'Agricultural', not 'Agriculture' (common LLM hallucination).",
    "Latest vintage as of project memory is SURV_YEAR=2024."
  ],
  "time_field": "SURV_YEAR",
  "fields": [
    { "name": "LUID",      "type": "esriFieldTypeString",  "alias": "Land Use ID", "length": 50 },
    { "name": "Landuse",   "type": "esriFieldTypeString",  "alias": "Land Use",    "length": 50, "domain_values": ["Agricultural", "Urban", "Riparian", "Open Water", "..."] },
    { "name": "SURV_YEAR", "type": "esriFieldTypeInteger", "alias": "Survey Year" },
    { "name": "Acres",     "type": "esriFieldTypeDouble",  "alias": "Acres" }
  ],
  "description": "Annual polygons of crop / land-use and irrigation method across Utah's developed-water basins…"
}
```

Top-level identity + curated facts come from S1's `SGID` (with `last_edit_date` overwritten by the live pjson fetch). `fields[]`, `geometry_type`, `max_record_count`, and `description` come from the live `?f=pjson`.

## Functional requirements

Pulled from epic §"Functional requirements":

- **F9.** `describe_layer` accepts either `{ org, layer }` or `{ url }`; combines cataloged metadata with live pjson re-fetch so `last_edit_date` is current.
- **F10.** `list_capabilities` returns the three-tier overview (categories with blurbs + layer counts, mapserv tools, search, query primitives, registered orgs).
- **F11.** `McpServer.instructions` is set to the policy paragraph from plan.md §"Discovery model" so handshake-time clients show it in the system-prompt area.
- **F12.** Every `list_<category>` tool description ends with the pairing nudge + `find_layer` fallback nudge. *(Verified in S5; template owned by S3.)*
- **F13.** Category-level gaps (e.g. cadastre's "NOT owner names — county-held") appear inline in both tool description and catalog return. *(Description side owned by S3; S5 verifies during AC walkthrough.)*

## Non-functional requirements

Pulled from epic §"Non-functional requirements":

- **N6.** Total tool list cost ~6.5K tokens (33 tools × ~200 tokens). **Measure after wire-up** (Task 13) and record in PR description.
- **N7.** The `describe_layer` per-isolate `Map` cache from v0.1 is preserved. Lifted from v0.1's `src/arcgis.ts` into `src/tools/generic.ts`.
- **N10.** `npm run typecheck` passes at the story boundary. (Should pass at every commit on the story branch, per epic norm.)

## Acceptance criteria

### The five conversations (epic A1–A5, plan.md §"Acceptance criteria")

A fresh MCP Inspector agent session with no pre-prompting must:

1. **A1 — Tier 1 aggregation.** *"How many acres of irrigated alfalfa in Utah in 2023?"* → calls `list_farming` → then `arcgis_aggregate({ org: "ugrc", layer: "wrlu", where: "Landuse='Agricultural' AND CropGroup='Alfalfa' AND IRR_Method<>'None' AND SURV_YEAR=2023", group_by: [], statistics: [{ field: "Acres", op: "sum", alias: "acres" }] })`. **No Python; no curl; no `arcgis_raw`.**
2. **A2 — mapserv.** *"What's the street address at 40.7608° N, 111.8910° W?"* → calls `reverse_geocode({ x: -111.8910, y: 40.7608 })`. **No curl; no manual HTTP.**
3. **A3 — Tier 1 query.** *"Which parcels overlap this polygon?"* (paste a small Box Elder polygon) → calls `list_cadastre` → then `arcgis_query({ org: "ugrc", layer: "parcels_lir", geometry: <polygon>, out_fields: ["PARCEL_ID", "COUNTY_NAME", "PARCEL_ACRES"] })`. **No manual ArcGIS REST URL composition.**
4. **A4 — Stratos / honest gaps.** *"Who owns the parcels inside this polygon?"* (Box Elder polygon) → calls `list_cadastre`, **reads the `category_gaps` field**, **explains to the user that LIR does NOT contain owner names** (county-held), and recommends either waiting for v0.3 county-portal coverage or using `arcgis_raw` against the relevant county AGOL org if the URL is known. **Must NOT hallucinate that LIR has owners; must NOT silently return whatever LIR fields are nearest in name.**
5. **A5 — Tier 2 long-tail.** *"Show me Utah's springs."* → calls `find_layer({ query: "springs" })` (because `list_water` doesn't surface a springs layer), picks the returned NHD springs URL, and queries via `arcgis_query({ url: <NHD springs URL>, … })`. **No Python; no assumption the data doesn't exist.**

A4 is the canonical regression test for hallucination/gap handling. A5 is the canonical regression test for long-tail coverage (the path-C pivot motivator).

### Story-level checks

6. `npm run typecheck` exits 0.
7. MCP Inspector tool count = **33** (20 `list_<category>` + 3 generic/search + 3 action + 7 mapserv).
8. The `INSTRUCTIONS` paragraph is visible in MCP Inspector's server-info pane after handshake.
9. `src/registry.ts` is absent from the working tree (`git ls-files src/registry.ts` returns nothing).
10. `package.json` `"version"` is `"0.2.0"`.
11. `CLAUDE.md` no longer references `list_layers`, `query_layer`, `aggregate_layer`, or `arcgis_query_raw` by name.
12. README exists at repo root and contains the 33-tool table and the `wrangler secret put UGRC_API_KEY` line.
13. Tool-list token cost measurement is recorded in the PR description (target ≤ ~6.5K tokens).

## Verification steps

```bash
cd /Users/coreywoodcox/Developer/cwoodcox/ugrc-mcp

# Build / type integrity
npm run typecheck                                              # exit 0
test ! -f src/registry.ts && echo "registry.ts removed"        # confirm deletion
grep '"version"' package.json                                   # expect "0.2.0"

# Description hygiene
grep -E '^[[:space:]]*"version"' package.json
grep -c 'Pair with `arcgis_query`' src/tools/sgid.ts            # template present
grep -c 'find_layer({ query })' src/tools/sgid.ts                # fallback nudge present
grep -E 'list_layers|query_layer|aggregate_layer|arcgis_query_raw' CLAUDE.md   # expect 0 matches

# Live wire-up
npm run dev                                                     # leave running
npx @modelcontextprotocol/inspector@latest                      # second terminal
# In Inspector:
#  - Connect to http://localhost:8787/mcp
#  - Confirm server-info pane shows the INSTRUCTIONS paragraph
#  - Confirm tool list count == 33
#  - Run each of A1..A5 as a fresh chat; validate tool-call sequence matches plan.md
#  - Record total tool-list token cost (names + descriptions + schemas) in PR description
```

## Risks & mitigations

| Risk | Mitigation in this story |
| --- | --- |
| **R3 — Tool-list token cost (~6.5K).** | Measure after wire-up (Task 13) and record in PR. If well over budget, file a follow-up to trim descriptions; do not block tag unless it breaks a client. |
| **R6 — `arcgis_query` discoverability.** | A1 / A3 / A5 are the regression bar. Per plan.md §"Acceptance criteria" final paragraph: **if any of the five conversations fail the same way they currently do, the discovery story needs more work before tagging v0.2.** Roll back to S3 (description tuning) or revisit `INSTRUCTIONS` wording — do not ship a regression. |
| **`INSTRUCTIONS` paraphrased instead of copied.** | Task 4 is explicit: copy verbatim. Implementer review the AC walkthrough output to spot any wording drift. |
| **`describe_layer` cache loss in the lift.** | Task 1 calls out the cache as `Map<string, unknown>` keyed by resolved URL. Smoke test by calling `describe_layer` twice in Inspector — second call should be sub-100ms. |
| **`{ org, layer } | { url }` discriminated union confuses the model.** | If A1/A3 fail because the model passes `{ url }` instead of `{ org, layer }`, tighten the `arcgis_query` description (S2 owns) — but only after confirming it's not an S5 description-copy issue. |
| **`mcp.ts` registration order surprises.** | Order tools by discovery → search → action → mapserv → generic; the tool list arrives in registration order in some clients, and that ordering reinforces the discovery-first story. |
| **S1–S4 not actually landed.** | Task 0 gates the work. Don't start S5 against an incomplete foundation — the cutover only makes sense once the parts are in place. |

## Cutover checklist (pre-tag)

The value-add of this story. Make it impossible to forget a leftover.

- [ ] All four prior stories (S1, S2, S3, S4) are merged to `main` (or to the integration branch this story sits on).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run sync-sgid-registry` exits 0 and produces zero diff (S1 idempotency holds at S5 time).
- [ ] The five acceptance conversations (A1–A5) all pass in MCP Inspector with a fresh agent session.
- [ ] Tool count visible in MCP Inspector = **33**.
- [ ] `INSTRUCTIONS` paragraph visible in MCP Inspector's server-info pane.
- [ ] `INSTRUCTIONS` text matches plan.md §"`McpServer.instructions`" verbatim (no paraphrase).
- [ ] Every rendered `list_<category>` description ends with the pairing-nudge sentence.
- [ ] README updated (33-tool table + `wrangler secret put UGRC_API_KEY` + quick-start).
- [ ] `CLAUDE.md` Architecture section reflects the discovery/action split, three coverage tiers, 33-tool surface; no named references to the five v0.1 tools.
- [ ] `CLAUDE.md` Commands section includes `npm run sync-sgid-registry` and the `wrangler secret put UGRC_API_KEY` line.
- [ ] `package.json` `"version"` bumped to `"0.2.0"`.
- [ ] `src/registry.ts` deleted from the working tree.
- [ ] `src/arcgis.ts` renamed to `src/arcgis-client.ts` (confirm S2 did it; finish here if not).
- [ ] No imports remain anywhere from `./registry` or `./arcgis` (only `./registry/*` and `./arcgis-client`).
- [ ] `wrangler.jsonc` has `UGRC_API_KEY` declared (S4); `worker-configuration.d.ts` regenerated.
- [ ] Tool-list token cost measured and recorded in the PR description.
- [ ] No leftover v0.1 tool defs inlined in `src/mcp.ts` — `init()` body is just `register*(server)` calls.

When every box is checked, tag `v0.2.0`.

## Notes / references

- **plan.md** sections: §"Discovery model" (entire; `instructions` paragraph is in §2 verbatim), §"Tool surface" → "Generic discovery + search (3 tools)" (`list_capabilities`, `describe_layer`), §"Discovery: SGID per-category" → description template (verified, not authored, here), §"Phases" Phase 5 and Phase 6, §"Acceptance criteria" (A1–A5), §"Risks" #3 and #6.
- **epic-v0.2.md** sections: §"Functional requirements" F9, F10, F11, F12, F13; §"Non-functional requirements" N6, N7, N10; §"Stories" S5 row; §"Epic-level acceptance criteria" A1–A5; §"Risks" R3 and R6.
- **CLAUDE.md** sections rewritten in this story: §"Repository state" (no longer greenfield), §"Stack" (layout line, describe_layer cache home), §"Architecture: what to internalize before writing code" (the 5-tool list is replaced by the discovery/action split + three tiers), §"Out of scope for v1" → §"Out of scope for v0.2" (carry over plan.md §"Out of scope for v0.2"), §"Acceptance test" (point at plan.md A1–A5), §"Commands" (add `sync-sgid-registry` + `wrangler secret put UGRC_API_KEY`).
- **v0.1 source files this story finishes off:**
  - `src/registry.ts` — deleted; v0.1 layer facts already migrated by S1 into `scripts/enrichment.ts`.
  - `src/mcp.ts` — gutted; the five inline tool defs are replaced by `register*(server)` calls.
  - `src/arcgis.ts` → `src/arcgis-client.ts` — rename confirmed (S2). The v0.1 `describeLayer` and its `SCHEMA_CACHE` are the source for S5's lifted cache.
- **MEMORY.md (user auto-memory):** WRLU + watersheds data-drift facts migrated by S1; A1 (alfalfa) and A3 (parcels) implicitly verify the migration end-to-end.
- **Final gate per plan.md §"Acceptance criteria":** *"If any of those five conversations fail the same way they currently do, the discovery story needs more work before tagging v0.2."* Do not tag if A4 or A5 regress.

## Open questions deferred

- Whether the `text()` helper consolidates to a shared `src/tools/_text.ts` or stays inlined per tool file — convention will be set by S2/S3/S4; S5 follows.
- Tool-list ordering in MCP Inspector — registration order is the current best lever; if any client renders alphabetically, that's a v0.3 concern.
- Whether to expose `INSTRUCTIONS` as an exported constant for testing — not required by any AC; leave as a `const` in `mcp.ts` unless a test harness wants it.
- If A4 fails because the model still hallucinates owner names despite the `category_gaps` field: the fix is either stronger wording in `CATEGORY_OVERRIDES.cadastre.category_gaps` (S1 edit) or a louder per-tool description nudge in `list_cadastre` (S3 edit). Document the observed failure in the PR and pick whichever lever the AC walkthrough suggests is missing.
