# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Greenfield. The only file is `spec.md` — a v1 design doc for a UGRC GIS MCP server. **Read `spec.md` end-to-end before making changes**; it defines the tool surface, layer registry, geometry conventions, and explicit non-goals. Not yet a git repo, no package metadata, no code.

## Stack

- **TypeScript on Cloudflare Workers.** `@modelcontextprotocol/sdk` + Cloudflare Agents SDK (`agents/mcp`) for streamable HTTP transport. The `McpAgent` base class puts MCP session state in a Durable Object — that's transparent; the business logic stays stateless.
- **HTTP:** native `fetch` wrapped with `AbortSignal.timeout(30_000)` and a 5xx retry helper. No `httpx`/axios.
- **Geometry:** hand-rolled GeoJSON↔esriJSON for Polygon/MultiPolygon in `src/geometry.ts`. Don't reach for `@turf/turf` in v1.
- **`describe_layer` cache:** module-level `Map` keyed by layer URL. Per-isolate, best-effort. Promote to KV/Cache API only if measured latency calls for it.
- No auth required for any v1 layer. If the server ever ships outside the Watts-for-Water context, gate the endpoint behind Cloudflare Access rather than baking auth into individual tools.

Layout: `src/index.ts` (Worker entrypoint), `src/mcp.ts` (`McpAgent` + tool registrations), `src/registry.ts`, `src/arcgis.ts`, `src/geometry.ts`. **`spec.md` is still authoritative for tool shapes, error semantics, and the layer registry** — only the Python-stack lines were superseded.

## Architecture: what to internalize before writing code

The five-tool surface is deliberately minimal. Don't add tools without justification — the design assumes the model composes these primitives.

1. **`list_layers`** — return registry.
2. **`describe_layer`** — fetch `?f=pjson`, surface `fields[]` (with coded-value `domain_values` inlined), `geometryType`, `extent`, `maxRecordCount`, `editingInfo.dataLastEditDate`. Cache per-process.
3. **`query_layer`** — POST to `<url>/query` (POST, not GET — long polygons exceed 2KB GET limits). Always set `f=geojson&outSR=4326`. Accept GeoJSON WGS84 in, return GeoJSON WGS84 out; the server owns the esriJSON conversion. Trust `exceededTransferLimit`, not feature count, to set `next_offset`. Do **not** auto-paginate — let the model chain.
4. **`aggregate_layer`** — server-side `outStatistics` + `groupByFieldsForStatistics`. This is where the headline numbers come from; the model should reach for it before paging features. May paginate internally (group counts rarely exceed 2k).
5. **`arcgis_query_raw`** — escape hatch. Passthrough to any FeatureServer/MapServer `/query` (or `queryAttachments`, etc.) with raw params. Return parsed JSON unchanged.

### Cross-cutting invariants

- **Geometry I/O is always GeoJSON in WGS84.** UGRC layers are stored in EPSG:26912 (UTM 12N NAD83); ArcGIS handles the transform server-side. For sub-meter precision, consider `datumTransformation=4485` on `inSR` — non-critical at v1's polygon scale.
- **ArcGIS errors return HTTP 200** with `{"error": {"code", "message"}}`. Detect this shape explicitly and re-raise as a tool error preserving code+message. A naive `response.raise_for_status()` will miss them.
- **Geometry-too-large** is a common failure mode when passing state-sized polygons as a spatial filter. Catch it and recommend `bbox` in the error message.
- **`spatial_relationship`** maps to ArcGIS `spatialRel` codes — translate `intersects`/`contains`/`within`/`crosses`/`touches`/`overlaps`/`envelope_intersects` rather than exposing the raw `esriSpatialRel*` enum.

### Layer registry note

`spec.md` lists 7 layers verified live May 2026. UGRC has historically renamed services — if a URL 404s, check `gis.utah.gov/products/sgid/...` rather than guessing.

## Out of scope for v1 (don't drift into these)

Write ops (`applyEdits`), image rendering (`export`), geocoding (separate API), other vendors (PVWatts/NSRDB/CropScape/HIFLD/SSURGO — each is its own MCP), feature-data caching, Open SGID Postgres direct access.

## Acceptance test

A single `aggregate_layer` call (see `spec.md` "Acceptance test") grouping 2023 irrigated alfalfa by `SubArea` should rank Bear River / Weber / Jordan / Sevier / Uinta near the top. If that works end-to-end, v1 ships.

## Commands

```bash
npm install                                  # first-time setup
npm run cf-typegen                           # regenerate worker-configuration.d.ts from wrangler.jsonc bindings; rerun after binding changes
npm run dev                                  # local wrangler dev — MCP at /mcp (streamable HTTP), legacy SSE at /sse
npm run typecheck                            # tsc --noEmit
npx wrangler deploy                          # ship to Cloudflare (account from `wrangler login`)
npx wrangler tail                            # stream production logs
npx @modelcontextprotocol/inspector@latest   # local MCP client for poking tools — point it at the dev URL + /mcp
```

No test suite yet. When tests land, document the runner and how to run a single test here.
