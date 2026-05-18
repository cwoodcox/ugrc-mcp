# ugrc-mcp v0.2 — expansion plan

Status: design doc, not yet implemented. v0.1 (the current `main`) ships 5 generic tools wrapping a 7-layer hand-curated registry. This document describes how v0.2 expands to ~39 tools covering 215+ SGID layers and the full UGRC Web API.

---

## The problem

The v0.1 tools (`list_layers`, `describe_layer`, `query_layer`, `aggregate_layer`, `arcgis_query_raw`) are correct but too abstract. Connected LLM agents repeatedly write Python scripts to hit ArcGIS REST endpoints directly instead of calling the existing tools. Even when explicitly pointed to `arcgis_query_raw`, they often fail to use it on the next turn.

**Diagnosis:** LLM tool selection is dominated by matching user intent against tool names and descriptions. `query_layer` matches no specific intent; `query_water` matches *"how much irrigated farmland is in the Bear River basin?"* via "water" → basin → irrigation. The fix is more, narrower, well-named tools — and a deliberate discovery story so consumers know they exist.

---

## Design principles

1. **Concrete beats abstract.** `query_cadastre` will be picked over `query_layer` ten times out of ten when a user asks about parcels.
2. **Tool names are the search index.** `verb_noun` naming, where the noun is the SGID category or mapserv capability. The model never sees a layer URL until it has already chosen the right tool.
3. **Tool descriptions are the layer catalog.** Each category tool's description enumerates the layers it covers. No separate `find_sgid_layer` tool needed for v0.2.
4. **Composition stays in the model's hands.** We don't auto-paginate, auto-aggregate, or auto-decide. The model chains primitives, same as v0.1.
5. **Discovery has multiple overlapping mechanisms.** Tool list, server `instructions`, per-tool description nudges, and a `list_capabilities` meta-tool. See "Discovery model" below.

---

## Discovery model — how consumers find the tools

This is the central design risk. The current pain (agents writing Python) is a discovery failure. v0.2 addresses it on four overlapping surfaces:

### 1. Tool names as the primary search index

LLM clients send the full tool list (names + descriptions + parameter schemas) to the model at session start. When the user asks a question, the model scans that list for matches against the intent. `query_water`, `query_cadastre`, `geocode_address`, `reverse_milepost` each pattern-match a recognizable shape of question. `query_layer` does not.

**This single change — verb_noun naming over a generic primitive — does most of the work.** Everything below is reinforcement.

### 2. `McpServer.instructions`

The MCP SDK exposes an `instructions: string` field on `McpServer` that the client receives at handshake. Most clients (Claude desktop, Cursor, MCP Inspector) surface this in the system prompt area. v0.2 sets it to a short policy statement:

> This server provides specialized tools for querying Utah's State Geographic Information Database (SGID) and the UGRC Web API. **Always prefer these tools over writing custom HTTP requests, Python scripts, or curl commands** — they handle geometry conversion (GeoJSON ↔ esriJSON), spatial reference projection, pagination, and ArcGIS error semantics. Start with `list_capabilities` if you're unsure which tool fits. For SGID data, the `query_<category>` tools (e.g., `query_cadastre`, `query_water`) are the entry points. Fall back to `arcgis_query_raw` only for service URLs not in any category.

### 3. Per-tool description nudges

Every category tool description ends with a fixed sentence: *"Use this instead of writing custom ArcGIS REST requests."* Redundant by design — LLMs respond strongly to direct instructions in the immediate tool-call context, and a few extra tokens per tool are cheap.

### 4. `list_capabilities` meta-tool

A small tool the model can call when uncertain or when the tool list has been compacted out of context. Returns a structured catalog:

```json
{
  "categories": [
    { "name": "cadastre", "tool": "query_cadastre", "blurb": "Parcels, ownership, taxation, zoning", "layer_count": 64 },
    { "name": "water",    "tool": "query_water",    "blurb": "Streams, lakes, hydrography",         "layer_count": 6 }
  ],
  "mapserv": [
    { "tool": "geocode_address",    "purpose": "Address → coordinates" },
    { "tool": "reverse_geocode",    "purpose": "Coordinates → address" }
  ],
  "generic": [
    { "tool": "describe_layer",     "purpose": "Schema for any layer key or URL" },
    { "tool": "aggregate_layer",    "purpose": "Server-side groupBy + statistics" },
    { "tool": "arcgis_query_raw",   "purpose": "Last-resort escape hatch" }
  ]
}
```

### Failure modes we still expect

- **Forgetting tools exist after long conversations.** Some clients drop the tool list during compression. `instructions` and `list_capabilities` are short enough that the model can re-orient quickly.
- **Picking the wrong category.** "Irrigated land" lives in `farming` (the WRLU layer), not `water`. Per-tool descriptions list specific layer names; `describe_layer` and `aggregate_layer` work across categories so a wrong-tool pick is recoverable.
- **Defaulting to Python for novel queries.** When an analysis pattern feels unfamiliar (complex multi-layer joins, attachments, etc.), models reach for code. `arcgis_query_raw` exists explicitly for "the higher-level tools don't cover this" — its description is the safety net.

The acceptance tests below validate that these mechanisms are working.

---

## Architecture

```
src/
  registry/
    sgid.ts          # generated from agrc/sgid-index — 28 categories × N layers
    mapserv.ts       # hand-written — the 7 mapserv endpoints
  tools/
    sgid.ts          # factory that emits 28 query_<category> tools
    mapserv.ts       # 7 mapserv tools
    generic.ts       # describe_layer, aggregate_layer, arcgis_query_raw, list_capabilities
  arcgis.ts          # unchanged — HTTP wrapper + geometry conversion
  geometry.ts        # unchanged
  mcp.ts             # wires it all together, sets server instructions
  index.ts           # unchanged
scripts/
  sync-sgid-registry.ts   # one-shot fetch + transform, run manually
docs/
  plan.md            # this file
```

---

## Data pipeline

### Upstream source

The canonical SGID layer catalog lives in a private Google Sheet (`SGID Index`) curated by UGRC. It's mirrored to a public GitHub repo at https://github.com/agrc/sgid-index, specifically the file `src/data/downloadMetadata.ts`. ~380 entries grouped by an `openSgid` category prefix (e.g., `cadastre.parcels`, `water.streams`, `transportation.roads`).

Of the ~380 entries:
- ~215 have an `openSgid` category and a usable AGOL FeatureServer URL — these become our registry.
- ~165 are hosted externally, lack a `openSgid` prefix, or have no queryable service. We drop them and document the gap. They remain accessible via `arcgis_query_raw` if their URL is known.

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
  filter: drop entries without (openSgid prefix && AGOL FeatureServer URL)
  ↓
  group by category prefix
  ↓
  write src/registry/sgid.ts
  ↓
  git diff — review, commit, deploy
```

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

### Generic (4 tools)

| Tool | Purpose |
| --- | --- |
| `describe_layer` | Schema summary for any layer key or FeatureServer URL. Use after picking a layer from a category tool. |
| `aggregate_layer` | Server-side `groupBy` + `outStatistics`. Reach for it before paging features for headline numbers. |
| `arcgis_query_raw` | Last-resort escape hatch. Description explicitly directs the model to category tools first. |
| `list_capabilities` | Overview: returns category names, tool names, blurbs, and layer counts. The model's "what's available here?" entry point. |

### SGID category (~28 tools)

One `query_<category>` per SGID category. Initial categories (from agrc/sgid-index):

`address`, `aerial-photography`, `base-maps`, `bioscience`, `boundaries`, `cadastre`, `climate`, `demographic`, `economy`, `elevation`, `energy`, `environment`, `farming`, `geoscience`, `health`, `history`, `indices`, `location`, `planning`, `political`, `recreation`, `society`, `topo`, `transportation`, `utilities`, `water`.

Each tool takes:
- `layer` — zod enum of that category's layer keys (the model sees the valid set directly in the schema).
- Plus the same params v0.1's `query_layer` accepts: `where`, `geometry`, `bbox`, `spatial_relationship`, `out_fields`, `return_geometry`, `order_by`, `limit`, `offset`, `distinct`.

Description template:

> Query Utah {DisplayName} layers. {Blurb}. Available layers: {comma-separated layer keys}. GeoJSON in/out, WGS84. Use this instead of writing custom ArcGIS REST requests.

### mapserv (7 tools)

Hand-written wrappers over https://api.mapserv.utah.gov/docs/.

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `geocode_address` | `/api/v1/geocode/{street}/{zone}` | Address → coordinates |
| `geocode_milepost` | `/api/v1/geocode/milepost/{route}/{milepost}` | UDOT route + milepost → coordinates |
| `reverse_geocode` | `/api/v1/geocode/reverse/{x}/{y}` | Coordinates → address |
| `reverse_milepost` | `/api/v1/geocode/milepost/{x}/{y}` | Coordinates → UDOT route + milepost |
| `search_sgid_via_mapserv` | `/api/v1/search/{table}/{fields}` | Mapserv's SQL-like search across 300+ layers (kept for query shapes AGOL `/query` can't express 1:1) |
| `list_sgid_tables` | `/api/v1/info/featureClassNames` | Enumerate mapserv-known table names |
| `list_sgid_fields` | `/api/v1/info/fieldnames/{tableName}` | Enumerate columns of a table |

All seven default `spatialReference=4326` in our wrapper (mapserv's native default is UTM 12N — annoying for an LLM). All seven require `UGRC_API_KEY` as a Worker secret. If unset, each tool returns a clear error:

> Set UGRC_API_KEY via `wrangler secret put UGRC_API_KEY`. Request a key at developer.mapserv.utah.gov.

---

## Phases

### Phase 1 — Registry sync

- Write `scripts/sync-sgid-registry.ts`.
- Run it. Commit `src/registry/sgid.ts`.
- Fold v0.1's 7 hand-curated layers into the appropriate categories. Remove `src/registry.ts`.

### Phase 2 — SGID category tools

- Build the factory in `src/tools/sgid.ts`.
- Register ~28 tools at server init.
- Update `mcp.ts` to use the new layout.
- Verify tool list renders correctly in MCP Inspector.

### Phase 3 — mapserv tools + API key

- Add `UGRC_API_KEY` to `Env` (`worker-configuration.d.ts` regenerates from `wrangler.jsonc`).
- Write the 7 tools in `src/tools/mapserv.ts`.
- Document `wrangler secret put UGRC_API_KEY` in README.

### Phase 4 — Discovery polish

- Set `instructions` on the `McpServer`.
- Implement `list_capabilities`.
- Retire `list_layers` (or alias it to `list_capabilities` for back-compat).
- Append the "Use this instead of writing custom ArcGIS REST requests" sentence to every category tool description.

### Phase 5 — Docs + cutover

- Update README tool table.
- Update CLAUDE.md architecture section.
- Tag v0.2.

---

## Risks

1. **`downloadMetadata.ts` upstream stability.** If agrc renames or moves the file, sync fails loudly (good). Pin a known-good commit SHA in the sync script and bump manually.
2. **No documented rate limit on mapserv.** If hosted-instance abuse becomes a problem, add a Cloudflare WAF rule or move behind Cloudflare Access. README already nudges heavy users to self-deploy.
3. **Tool list token cost.** ~39 tools × ~200 tokens each ≈ 8K tokens of tool metadata on every session. Real but acceptable — trade for dramatically better tool-selection behavior. Measure after Phase 4 ships.
4. **Zod enum size.** Largest category (cadastre, ~64 layers) gives a 64-element enum. Fine for Zod; some MCP clients may render long enums awkwardly. Flag if observed.
5. **SGID layer URL drift.** UGRC has historically renamed services. The sync script can't catch this — it only sees what upstream advertises. Mitigation: when a tool call 404s, the error surfaces the layer key, making it easy to either fix the registry or fall back to `arcgis_query_raw`.

---

## Acceptance criteria

A fresh agent with no prompting beyond the MCP connection should:

1. Answer *"how many acres of irrigated alfalfa in Utah in 2023?"* by calling `query_farming` (or `aggregate_layer` on the WRLU key) — **not** by writing Python.
2. Answer *"what's the street address at 40.7608° N, 111.8910° W?"* by calling `reverse_geocode` — **not** by writing curl.
3. Answer *"which parcels overlap this polygon?"* by calling `query_cadastre` with `parcels_lir` — **not** by composing a manual ArcGIS REST URL.

If any of those three conversations fail the same way they currently do, the discovery story needs more work before tagging v0.2.
