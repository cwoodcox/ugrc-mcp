# ugrc-mcp

An MCP server for Utah's State Geographic Information Database (SGID) and the UGRC Web API. Wraps ArcGIS Feature Services + mapserv so an LLM can discover layers, query features, and aggregate without writing Python or curl.

Runs on Cloudflare Workers. Built with `@modelcontextprotocol/sdk` and the Cloudflare Agents SDK (`agents/mcp`). MCP session state lives in a Durable Object; business logic is stateless.

See [`docs/plan.md`](./docs/plan.md) for the authoritative design (discovery model, registry pipeline, acceptance criteria). [`docs/epic-v0.2.md`](./docs/epic-v0.2.md) tracks epic scope; [`docs/stories/`](./docs/stories/) has per-story rollout notes.

## Tools (33)

Three coverage tiers: cataloged SGID core via `list_<category>` (Tier 1), uncategorized UGRC via `find_layer` (Tier 2), outside-UGRC via `arcgis_raw` (Tier 3).

### Generic discovery (2)

| Tool | Purpose |
| --- | --- |
| `list_capabilities` | Overview of all three tiers — categories with blurbs/layer counts, mapserv tools, query primitives, registered orgs. Call first if uncertain. |
| `describe_layer` | Full schema for a cataloged (`{ org, layer }`) or arbitrary (`{ url }`) layer. Fields with coded-value domains, current `last_edit_date` (re-fetched live), plus curated `gaps` / `caveats`. Per-isolate cached. |

### SGID category discovery (20)

One `list_<category>` per SGID category. Returns the catalog (per-layer freshness, useful fields, known gaps). Pair with `arcgis_query` / `arcgis_aggregate`.

`list_cadastre`, `list_society`, `list_indices`, `list_boundaries`, `list_demographic`, `list_energy`, `list_environment`, `list_geoscience`, `list_political`, `list_recreation`, `list_location`, `list_water`, `list_economy`, `list_health`, `list_transportation`, `list_planning`, `list_utilities`, `list_elevation`, `list_farming`, `list_climate`.

### Long-tail search (1)

| Tool | Purpose |
| --- | --- |
| `find_layer` | Live ArcGIS Hub Search across UGRC's full catalog (~763 Feature Services). Use when no `list_<category>` surfaces the layer. Returns URLs ready for `arcgis_query({ url, ... })`. Capped at 50. |

### Action: query primitives (3)

| Tool | Purpose |
| --- | --- |
| `arcgis_query` | Feature read — `where`, spatial filter, pagination. Takes EITHER `{ org, layer }` (Tier 1) OR `{ url }` (Tier 2/3). GeoJSON in/out, WGS84. |
| `arcgis_aggregate` | Server-side `groupBy` + `outStatistics`. Same dual-shape input. Reach for this before paging features for headline numbers. |
| `arcgis_raw` | Escape hatch — direct ArcGIS REST passthrough. For non-UGRC services or endpoints the primitives can't model (`queryAttachments`, image export, multipoint geometries). |

### mapserv (7)

All seven require `UGRC_API_KEY` and default to `spatialReference=4326`. See [Configuration](#configuration).

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `geocode_address` | `/api/v1/geocode/{street}/{zone}` | Address → coordinates |
| `reverse_geocode` | `/api/v1/geocode/reverse/{x}/{y}` | Coordinates → address |
| `geocode_milepost` | `/api/v1/geocode/milepost/{route}/{milepost}` | UDOT route + milepost → coordinates |
| `reverse_milepost` | `/api/v1/geocode/reversemilepost/{x}/{y}` | Coordinates → UDOT route + milepost |
| `search_sgid_via_mapserv` | `/api/v1/search/{table}/{fields}` | SQL-like search over mapserv-known SGID tables |
| `list_sgid_tables` | `/api/v1/info/featureClassNames` | Enumerate mapserv-known table names |
| `list_sgid_fields` | `/api/v1/info/fieldnames/{table}` | Enumerate columns of a mapserv table |

Geometry I/O is always GeoJSON in WGS84 (EPSG:4326). ArcGIS handles reprojection to the layer's stored SR (EPSG:26912 for most UGRC layers).

## Endpoints

- `POST /mcp` — streamable HTTP transport (preferred).
- `GET/POST /sse` — legacy SSE transport.

## Live deployment

Hosted instance on Cloudflare Workers: `https://ugrc-mcp.ompwwcx2yz.workers.dev` — point an MCP client at `/mcp`. Unauthenticated and runs on my personal account, so please be nice: light, exploratory use is fine, but if you're hammering it or building something real on top, deploy your own (`npx wrangler deploy` — it's free-tier friendly).

## Configuration

Set the mapserv API key once per environment:

- Local dev: copy `.dev.vars.example` to `.dev.vars` and fill in your key (`.dev.vars` is gitignored).
- Deployed: `wrangler secret put UGRC_API_KEY`

Request a key at https://developer.mapserv.utah.gov. Tools that need it short-circuit with a clear message if the secret is unset.

Mapserv keys are issued with a Referer allow-list. The Worker sends a configurable `Referer` header on every mapserv request; the default (`UGRC_API_REFERER` in `wrangler.jsonc`) targets this repo's prod URL. If you self-deploy on a different `workers.dev` subdomain, override `UGRC_API_REFERER` so its value matches whatever pattern your key allows.

## Setup

```bash
npm install
npm run cf-typegen    # regenerate worker-configuration.d.ts after wrangler.jsonc binding changes
```

## Develop

```bash
npm run dev                  # wrangler dev — server at http://localhost:8787
npm run typecheck            # tsc --noEmit
npm run sync-sgid-registry   # refresh src/registry/sgid.ts from agrc/sgid-index
```

Poke the tools with the MCP Inspector pointed at `http://localhost:8787/mcp`:

```bash
npx @modelcontextprotocol/inspector@latest
```

## Deploy

```bash
npx wrangler deploy   # Cloudflare account from `wrangler login`
npx wrangler tail     # stream production logs
```

## License

MIT — see [`LICENSE`](./LICENSE).

## Acceptance test

The five canonical conversations from [`docs/plan.md` §"Acceptance criteria"](./docs/plan.md#acceptance-criteria) (A1–A5) — irrigated-alfalfa aggregation, reverse-geocode, parcel polygon overlay, Stratos honest-gaps cadastre query, and the springs long-tail (`find_layer` → NHD Springs). A fresh MCP Inspector agent must walk all five without writing Python or curl.
