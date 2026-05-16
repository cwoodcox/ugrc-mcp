# UGRC GIS MCP Server — v1 Spec

A Model Context Protocol server that wraps Utah's State Geographic Information Database (SGID) ArcGIS Feature Services for use by an LLM assistant. Designed for the Watts for Water project — discovery queries, parcel-level case studies, and intersect-based polygon analysis (e.g., Stratos boundary vs. WRLU vs. parcels).

The design goal is **the smallest set of tools that lets an LLM run any analytically useful query against UGRC**, with enough structure that the model doesn't need to know ArcGIS REST quirks. The schema is opinionated: a small registry of named layers, a canonical geometry format (GeoJSON WGS84), and explicit pagination/aggregation modes.

---

## Implementation recommendation

- **Runtime:** TypeScript on Cloudflare Workers, using [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) and the Cloudflare Agents SDK ([`agents/mcp`](https://developers.cloudflare.com/agents/mcp/)) for streamable HTTP transport. ~300 lines for v1.
- **HTTP:** native `fetch`. Wrap in a small helper with `AbortSignal.timeout(30_000)` and retry on 5xx.
- **Geometry:** hand-roll GeoJSON↔esriJSON for Polygon/MultiPolygon (~30 lines). No `@turf/turf` dependency in v1; `outSR=4326` keeps the response side trivial.
- **State:** Stateless business logic. The layer registry is a constant in `src/registry.ts`. MCP session state lives in a Durable Object (`McpAgent` from `agents/mcp`) — invisible to callers.
- **Caching:** isolate-local `Map` for `describe_layer` results — best-effort per isolate, no cross-region coordination needed at v1's request volume. Promote to KV / Cache API only if cache-miss latency hurts.
- **Auth:** None required for any layer in v1. The MCP endpoint itself can stay unauthenticated for the closed Watts-for-Water use case; if it ships externally, gate behind Cloudflare Access rather than baking auth into individual tools.

Layout: `src/index.ts` (Worker entrypoint), `src/mcp.ts` (`McpAgent` + tool registrations), `src/registry.ts` (layer constants), `src/arcgis.ts` (ArcGIS REST adapter), `src/geometry.ts` (GeoJSON↔esriJSON). Local dev via `npm run dev` (wrangler), deploy via `npx wrangler deploy`.

---

## Layer registry

A constant dict mapping short names to canonical Feature Service URLs. v1 ships with these. Adding more is one PR.

```python
LAYERS = {
    "wrlu": {
        "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/WaterRelatedLandUse/FeatureServer/0",
        "name": "Water Related Land Use",
        "steward": "Utah Division of Water Resources",
        "id_field": "LUID",
        "useful_fields": ["Landuse", "CropGroup", "Description", "IRR_Method", "Acres", "Basin", "SubArea", "SURV_YEAR"],
        "notes": "Annual polygons of crop/land-use + irrigation method. SURV_YEAR distinguishes vintages — filter on it for time-series. LUID is NOT stable across years.",
    },
    "parcels_lir": {
        "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/LIRParcels_Utah/FeatureServer/0",
        "name": "Utah LIR Parcels",
        "steward": "UGRC + counties",
        "id_field": "PARCEL_ID",
        "useful_fields": ["PARCEL_ID", "COUNTY_NAME", "PARCEL_ACRES", "PROP_CLASS", "OWN_TYPE", "TOTAL_MKT_VALUE", "LAND_MKT_VALUE", "TAXEXEMPT_TYPE"],
        "notes": "Statewide parcels with assessor attributes. Coverage is best-effort; check per-parcel asof date.",
    },
    "parcels_basic": {
        "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/Parcels_Utah/FeatureServer/0",
        "name": "Utah Parcels (basic)",
        "steward": "UGRC + counties",
        "id_field": "PARCEL_ID",
        "notes": "Geometry-only parcels; broader coverage than LIR but no assessor attributes.",
    },
    "watersheds_huc12": {
        "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahWatershedsArea/FeatureServer/0",
        "name": "Utah Watersheds Area",
        "steward": "USGS / UGRC",
        "id_field": "HUC12",
        "useful_fields": ["HUC12", "HUC10", "HUC8", "HU_12_NAME", "HU_8_NAME"],
        "notes": "Use HUC8 / HUC10 / HUC12 to determine basin drainage. Bonneville Basin HUC8s are the GSL drainage set.",
    },
    "ag_protection_areas": {
        "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/AgriculturalProtectionAreas/FeatureServer/0",
        "name": "Utah Agricultural Protection Areas",
        "steward": "Utah Department of Agriculture and Food",
        "notes": "Lots under voluntary 20-year ag covenants — a hard exclusion or special-case for any conversion program.",
    },
    "land_ownership": {
        "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/LandOwnership/FeatureServer/0",
        "name": "Utah Land Ownership",
        "steward": "UGRC",
        "useful_fields": ["OWNER", "ADMIN", "STATE_LGD"],
        "notes": "BLM / SITLA / Tribal / State / Private classification.",
    },
    "solar_zones": {
        "url": "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahSolarZones/FeatureServer/0",
        "name": "Utah Renewable Energy Zones — Solar",
        "steward": "Utah Office of Energy Development",
        "notes": "First-pass solar-suitability screening polygons.",
    },
}
```

The first three (`wrlu`, `parcels_lir`, `watersheds_huc12`) are sufficient for v1 if you want to cut the registry tighter. Add the others as needed.

URL stability note: UGRC has occasionally renamed services. If a URL 404s, the implementer should check `gis.utah.gov/products/sgid/...` for the current canonical URL — but the seven above were verified live in May 2026.

---

## Tool surface

Five tools. Each does one thing.

### 1. `list_layers`

Return the registry.

**Parameters:** none.

**Returns:**
```json
{
  "layers": [
    {"key": "wrlu", "name": "Water Related Land Use", "steward": "...", "notes": "..."},
    ...
  ]
}
```

Used by the model to discover what's available before calling `describe_layer` or `query_layer`.

---

### 2. `describe_layer`

Fetch and summarize the schema for a layer.

**Parameters:**
- `layer` (string, required): a key from the registry, OR an arbitrary FeatureServer URL ending in `/N`.

**Behavior:**
- GET `<url>?f=pjson`
- Extract `fields[]` (name, alias, type, length, domain), `geometryType`, `extent`, `maxRecordCount`, `defaultVisibility`, `description`, `editingInfo.dataLastEditDate`.
- Cache the result in-process for the layer key.

**Returns:**
```json
{
  "layer": "wrlu",
  "name": "WaterRelatedLandUse",
  "geometry_type": "esriGeometryPolygon",
  "max_record_count": 2000,
  "data_last_edit_date": "2026-03-04T...",
  "extent": {"xmin": ..., "ymin": ..., "xmax": ..., "ymax": ..., "spatial_reference": "EPSG:26912"},
  "fields": [
    {"name": "LUID", "type": "esriFieldTypeInteger", "alias": "LUID"},
    {"name": "Landuse", "type": "esriFieldTypeString", "alias": "Landuse", "domain_values": ["Agriculture", "Other", "Riparian/Wetland", "Urban", "Water"]},
    ...
  ],
  "description": "<original description text, truncated to 2000 chars>"
}
```

If the response includes a coded-value domain on a field, expose it inline as `domain_values` so the model knows what filter values are valid.

---

### 3. `query_layer`

The workhorse. Returns features.

**Parameters:**
- `layer` (string, required): registry key or full URL.
- `where` (string, optional, default `"1=1"`): SQL-92 WHERE clause. ArcGIS dialect — single quotes for strings, `LIKE '%...%'`, etc.
- `geometry` (object, optional): GeoJSON Geometry (Point, LineString, Polygon, MultiPolygon) in WGS84 (EPSG:4326). Server reprojects to layer SR internally. Mutually exclusive with `bbox`.
- `bbox` (array of 4 floats, optional): `[xmin, ymin, xmax, ymax]` in WGS84. Convenience for envelope queries.
- `spatial_relationship` (string, optional, default `"intersects"`): one of `intersects`, `contains`, `within`, `crosses`, `touches`, `overlaps`, `envelope_intersects`. Maps to ArcGIS `spatialRel` codes.
- `out_fields` (array of strings, optional, default `["*"]`): fields to return.
- `return_geometry` (bool, optional, default `true`): include polygon/point geometry in the response.
- `order_by` (array of strings, optional): e.g., `["Acres DESC"]`.
- `limit` (int, optional, default `500`, max `2000`): page size.
- `offset` (int, optional, default `0`): for pagination.
- `distinct` (bool, optional, default `false`): if true, sets `returnDistinctValues=true` and drops geometry. Useful for "what crop types appear in this polygon."

**Behavior:**
- Convert `geometry` (GeoJSON) → esriJSON polygon. If `bbox` given, build an envelope.
- POST to `<url>/query` with form-encoded params (POST handles long polygons cleanly; GET breaks at ~2KB).
- Set `f=geojson` always for the response — eliminates the esriJSON → GeoJSON conversion in the LLM.
- Set `outSR=4326` always.
- Trust `exceededTransferLimit` from the response, not the feature count.

**Returns:**
```json
{
  "features": [
    {"type": "Feature", "id": 12345, "geometry": {...GeoJSON...}, "properties": {"Landuse": "Agriculture", "Description": "Alfalfa", ...}}
  ],
  "feature_count": 487,
  "exceeded_transfer_limit": false,
  "next_offset": null,
  "spatial_reference": "EPSG:4326",
  "layer": "wrlu",
  "where": "Landuse = 'Agriculture' AND Description LIKE 'Alfalfa%'"
}
```

If `exceeded_transfer_limit=true`, set `next_offset = offset + len(features)` so the model can chain calls.

**Error handling:**
- ArcGIS errors return HTTP 200 with `{"error": {"code": ..., "message": ...}}`. Detect this shape and raise as a tool error with the code/message preserved.
- Geometry-too-large errors (common when passing a state-sized polygon as the spatial filter): return a clear message recommending the model use `bbox` first to narrow.

---

### 4. `aggregate_layer`

Server-side aggregation. Critical for "how many acres of irrigated alfalfa in HUC10 X" without paging through every polygon.

**Parameters:**
- `layer` (string, required).
- `where` (string, optional).
- `geometry` / `bbox` / `spatial_relationship` (same as `query_layer`).
- `group_by` (array of strings, optional): fields to group by. Empty = global aggregate.
- `statistics` (array of objects, required): each `{field, op, alias}` where `op` is one of `sum`, `count`, `min`, `max`, `avg`, `var`, `stddev`. Example: `[{"field": "Acres", "op": "sum", "alias": "total_acres"}, {"field": "LUID", "op": "count", "alias": "n_polygons"}]`.
- `order_by` (array of strings, optional): may reference statistic aliases.
- `limit` (int, optional, default `1000`).

**Behavior:**
- Build the `outStatistics` JSON ArcGIS expects.
- POST to `<url>/query` with `outStatistics`, `groupByFieldsForStatistics`, `returnGeometry=false`, `f=json`.
- Flatten the response so each row is a `{group: {...}, stats: {...}}` pair.

**Returns:**
```json
{
  "groups": [
    {"group": {"Description": "Alfalfa", "IRR_Method": "Flood"}, "stats": {"total_acres": 87432.1, "n_polygons": 1245}},
    {"group": {"Description": "Alfalfa", "IRR_Method": "Sprinkler"}, "stats": {"total_acres": 41203.4, "n_polygons": 612}}
  ],
  "total_groups": 12,
  "layer": "wrlu",
  "where": "Landuse = 'Agriculture'",
  "spatial_filter": {"type": "Polygon", "coordinates": [...]}
}
```

This is the tool the social-media headline numbers come out of.

---

### 5. `arcgis_query_raw`

Escape hatch. Direct passthrough to any ArcGIS REST `/query` endpoint with arbitrary params. Used when the model needs a feature service that's not in the registry, or a parameter the higher-level tools don't expose (e.g., `returnIdsOnly`, `relationParam`, multipoint geometry types).

**Parameters:**
- `service_url` (string, required): full URL ending in `/FeatureServer/N` or `/MapServer/N`.
- `endpoint` (string, optional, default `"query"`): one of `query`, `queryAttachments`, etc.
- `params` (object, required): raw query parameters. Server JSON-encodes objects, passes scalars through.

**Behavior:**
- POST `<service_url>/<endpoint>` with the params as form-encoded body.
- Return the parsed JSON response unchanged.

**Returns:** the raw JSON ArcGIS sends. No transformation.

---

## Geometry conventions

**Input format: GeoJSON in WGS84 (EPSG:4326).** Always. The model produces GeoJSON natively; ArcGIS prefers esriJSON; the server handles the conversion.

**Bounding box shorthand:** `bbox = [xmin, ymin, xmax, ymax]` in lon/lat. Used for "the rough Stratos area" type queries before you have a real polygon.

**Output format: GeoJSON in WGS84.** Always pass `f=geojson&outSR=4326` to ArcGIS. Don't make the model deal with esriJSON or UTM 12N.

**Coordinate transformation note:** UGRC layers are stored in EPSG:26912 (UTM 12N NAD83). ArcGIS handles the WGS84↔NAD83 transform server-side, but for sub-meter precision the implementer should consider passing `datumTransformation=4485` (the `NAD_1983_To_WGS_1984_5` transform) on `inSR` queries. Not critical for v1 at the scale of 40,000-acre polygons.

---

## Pagination contract

`query_layer` returns `next_offset: int | null` whenever `exceeded_transfer_limit` is true. The model is responsible for chaining. The server should NOT auto-paginate — that risks pulling 100,000 polygons into context. Make the model decide.

For aggregation, `aggregate_layer` paginates internally if needed (group counts rarely exceed 2,000), and returns the full result.

---

## Stratos polygon — manual ingestion path

The Stratos boundary exists as a county PDF map, not digital geometry. For v1, the cleanest path is:

1. User hand-traces the three polygons in [felt.com](https://felt.com) or QGIS using the PDF as a backdrop.
2. Exports as GeoJSON.
3. Drops the GeoJSON into the project knowledge folder, or pastes inline in chat.
4. Model passes that GeoJSON as the `geometry` parameter on every Stratos-related query.

This is a one-time effort (~20 min) and decouples the analysis from waiting for Box Elder County to publish a recorded boundary. The MCP doesn't need any special "Stratos" handling.

---

## Example end-to-end flow (the conversation that should work after v1 ships)

The model wants to answer: *"How much irrigated alfalfa is in the Stratos polygon, and what would the same area in Sanpete County look like?"*

```
1. list_layers()
   → confirms wrlu and watersheds_huc12 exist

2. describe_layer(layer="wrlu")
   → confirms Description field has Alfalfa values; Landuse/IRR_Method enum

3. aggregate_layer(
     layer="wrlu",
     geometry=<stratos_polygon_geojson>,
     where="SURV_YEAR = 2023",
     group_by=["Landuse", "IRR_Method"],
     statistics=[{"field": "Acres", "op": "sum", "alias": "total_acres"}]
   )
   → Stratos breakdown: how many acres are Agriculture/Flood vs. Other/None vs. Riparian/None

4. aggregate_layer(
     layer="wrlu",
     where="SURV_YEAR = 2023 AND Description LIKE 'Alfalfa%' AND IRR_Method <> 'Dry Crop'",
     bbox=[-111.85, 39.30, -111.40, 39.95],   # Sanpete County rough envelope
     group_by=["IRR_Method"],
     statistics=[{"field": "Acres", "op": "sum", "alias": "total_acres"}]
   )
   → Sanpete irrigated alfalfa breakdown

5. query_layer(
     layer="parcels_lir",
     geometry=<stratos_polygon_geojson>,
     out_fields=["PARCEL_ID", "COUNTY_NAME", "PARCEL_ACRES", "PROP_CLASS", "OWN_TYPE", "TOTAL_MKT_VALUE"],
     return_geometry=false,
     limit=2000
   )
   → list of parcels Stratos overlaps, with assessor data
```

If those four calls work end-to-end, the MCP is good enough to write the infographic.

---

## What's deliberately out of scope for v1

- **Write operations.** Read-only. Adding `applyEdits` is unnecessary and dangerous.
- **Image rendering.** No `export` endpoint. Maps are produced downstream by the model or an external artifact.
- **Geocoding.** UGRC's `api.mapserv.utah.gov` is a separate API with separate auth — fold it in as v2 if needed.
- **Other vendors.** No PVWatts, NSRDB, CropScape, HIFLD, or SSURGO. Each is its own MCP — but they share patterns and the second one will be quicker.
- **Caching of feature data.** Schema caching is fine; result caching introduces consistency questions and isn't worth the complexity at this scale.
- **Open SGID PostgreSQL.** Postgres-direct access is more powerful but requires a different auth model and connection management. Add as v2 once the ArcGIS surface is exhausted.

---

## Acceptance test (one query)

The MCP is ready to ship when this single call returns a sensible answer:

```python
aggregate_layer(
    layer="wrlu",
    where="Landuse = 'Agriculture' AND Description LIKE 'Alfalfa%' AND IRR_Method <> 'Dry Crop' AND SURV_YEAR = 2023",
    group_by=["SubArea"],
    statistics=[
        {"field": "Acres", "op": "sum", "alias": "total_acres"},
        {"field": "LUID",  "op": "count", "alias": "n_polygons"}
    ],
    order_by=["total_acres DESC"]
)
```

Expected: a list of DWRe subareas (~HUC8 boundaries) ranked by total irrigated alfalfa acreage. Bear River, Weber, Jordan, Sevier, and Uinta should be near the top. If you see those subareas with thousands of acres each, the MCP is working and we can start the discovery analysis.
