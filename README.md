# ugrc-mcp

An MCP server that wraps Utah's State Geographic Information Database (SGID) ArcGIS Feature Services so an LLM can run discovery queries, parcel-level case studies, and intersect-based polygon analysis against UGRC layers (WRLU, parcels, watersheds, etc.).

Runs on Cloudflare Workers. Built with `@modelcontextprotocol/sdk` and the Cloudflare Agents SDK (`agents/mcp`). MCP session state lives in a Durable Object; business logic is stateless.

See [`spec.md`](./spec.md) for the authoritative tool contracts, layer registry, geometry conventions, error semantics, and non-goals. See [`CLAUDE.md`](./CLAUDE.md) for stack-specific notes that supersede the Python references in the spec.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_layers` | Return the registry of named UGRC layers. |
| `describe_layer` | Schema summary — fields (with coded-value domains inlined), geometry type, extent, `maxRecordCount`, last edit date. Cached per-isolate. |
| `query_layer` | Feature query. GeoJSON in / GeoJSON out, WGS84. Supports `where`, spatial filter (`geometry` or `bbox` + `spatial_relationship`), pagination via `next_offset`. |
| `aggregate_layer` | Server-side `groupBy` + `outStatistics`. Use before paging features for headline numbers. |
| `arcgis_query_raw` | Escape hatch — passthrough to any ArcGIS REST `/query` (or `queryAttachments`, etc.) endpoint with raw params. |

Geometry I/O is always GeoJSON in WGS84 (EPSG:4326). ArcGIS handles the reprojection to the layer's stored SR (EPSG:26912 for most UGRC layers).

## Endpoints

- `POST /mcp` — streamable HTTP transport (preferred).
- `GET/POST /sse` — legacy SSE transport.

## Live deployment

Hosted instance on Cloudflare Workers: `https://ugrc-mcp.ompwwcx2yz.workers.dev` — point an MCP client at `/mcp`. Unauthenticated and runs on my personal account, so please be nice: light, exploratory use is fine, but if you're hammering it or building something real on top, deploy your own (`npx wrangler deploy` — it's free-tier friendly).

## Setup

```bash
npm install
npm run cf-typegen    # regenerate worker-configuration.d.ts after wrangler.jsonc binding changes
```

## Develop

```bash
npm run dev           # wrangler dev — server at http://localhost:8787
npm run typecheck     # tsc --noEmit
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

A single `aggregate_layer` call (full params in [`spec.md`](./spec.md#acceptance-test-one-query)) grouping 2023 irrigated alfalfa by `SubArea` should rank Bear River / Weber / Jordan / Sevier / Uinta near the top. If that works end-to-end, v1 is shippable.
