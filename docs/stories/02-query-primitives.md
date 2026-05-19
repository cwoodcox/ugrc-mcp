# Story 2 — Query primitives, first-class

Rewrite v0.1's `query_layer` / `aggregate_layer` / `arcgis_query_raw` into v0.2's `arcgis_query` / `arcgis_aggregate` / `arcgis_raw` with a discriminated `{ org, layer } | { url }` input shape, and split the v0.1 `src/arcgis.ts` module into an internal HTTP client and a tool surface.

## Goal

This story delivers the **action half** of the discovery-vs-action pivot. v0.1's primitives took a single `layer: string` that doubled as a registry key or a URL — opaque and discouraging to LLM agents. v0.2 makes the input *discriminated*: cataloged Tier 1 layers are addressed by `{ org: "ugrc", layer: "wrlu" }` (the MCP joins `ORGS[org].url_base + entry.service_path`), while Tier 2 layers surfaced by `find_layer` are addressed by `{ url }` directly. This shape is what lets every discovery tool — `list_<category>` and `find_layer` alike — hand the agent a structured handoff that flows naturally into a query call without the agent ever transcribing an opaque AGOL ID. The rewrite preserves v0.1's return shapes byte-for-byte so the existing SubArea acceptance test still passes; the change is the input contract, the file layout, and the framing in tool descriptions.

## What this story IS

- Rename `src/arcgis.ts` → `src/arcgis-client.ts` — the internal HTTP/protocol layer (`arcgisJson`, `applySpatialFilter`, ArcGIS-error detection, retry).
- Create `src/tools/arcgis.ts` — the tool surface, exporting three pure functions:
  - `arcgisQuery({ org, layer, ... } | { url, ... })` → v0.1 `queryLayer` return shape
  - `arcgisAggregate({ org, layer, ... } | { url, ... })` → v0.1 `aggregateLayer` return shape
  - `arcgisRaw({ url, endpoint?, params })` → v0.1 `rawQuery` return shape
- Implement a `resolveTarget(input)` helper that returns `{ url, label }` where `label` is `"ugrc/wrlu"` for cataloged inputs and the URL itself for `{ url }` inputs — `label` flows into every error message so URL drift is diagnosable.
- Preserve every v0.1 invariant: native `fetch` with `AbortSignal.timeout(30_000)`, 5xx retry with backoff, ArcGIS-200-with-error detection, POST `/query`, GeoJSON in/out / WGS84, geometry-too-large hint pointing to bbox.
- Preserve every v0.1 return field exactly: `features` / `feature_count` / `exceeded_transfer_limit` / `next_offset` / `spatial_reference` for query; `groups` / `total_groups` / `where` / `spatial_filter` for aggregate.
- Export candidate tool description strings from the same module so Story 5's wire-up reuses them verbatim.

## What this story IS NOT

- **Does NOT** register these tools in `src/mcp.ts`. Story 5 owns the cutover from v0.1 tool defs to v0.2 tool defs. Until then, `mcp.ts` keeps registering v0.1's `query_layer` / `aggregate_layer` / `arcgis_query_raw` from `src/arcgis.ts` … wait — see "Files edited" below for the rename mechanics.
- **Does NOT** touch `describe_layer`. That tool, the per-isolate `SCHEMA_CACHE`, and the `extractDomainValues` helper move in Story 5 (`src/tools/generic.ts`).
- **Does NOT** implement `find_layer`. Story 3 owns Hub Search.
- **Does NOT** delete `src/registry.ts` (v0.1's 7-layer hand-curated registry). Story 5 removes it as part of the cutover.
- **Does NOT** modify `src/geometry.ts` — GeoJSON↔esriJSON conversion is unchanged.
- **Does NOT** add a `URLEncode` / Turf-style geometry helper or auto-paginate.

## Dependencies

- **Depends on Story 1** for the registry types exported from `src/registry/`:
  - `ORGS` map from `src/registry/orgs.ts` (specifically `ORGS[org].url_base`)
  - `LayerEntry` type and the `SGID_CATEGORIES` (or equivalent) export from `src/registry/sgid.ts` that lets `resolveTarget` look up `service_path` by `(org, layer)`.
  - The committed `src/registry/sgid.ts` data is **not** required for this story to typecheck — only the type exports are. Story 2 can run against a stub registry if Story 1's sync hasn't completed.
- **Can run in parallel with** Story 3 (SGID discovery factory + `find_layer`) and Story 4 (mapserv).
- **Unblocks Story 5** — discovery polish + wire-up cannot finish without these tools.

## Files created

- `src/tools/arcgis.ts` — new file. Exports `arcgisQuery`, `arcgisAggregate`, `arcgisRaw`, the input zod schemas, and the description strings. Pulls `arcgisJson` + `applySpatialFilter` from `src/arcgis-client.ts` and `ORGS` + the SGID registry from `src/registry/`.
- `src/arcgis-client.ts` — created via rename (see below). Internal-only; not consumed by `mcp.ts`.

## Files edited

- `src/arcgis.ts` → renamed to `src/arcgis-client.ts` with `git mv`. The renamed file is trimmed down to just the internal HTTP layer:
  - **Keeps:** `arcgisJson`, `applySpatialFilter`, the GeoJSON-related re-exports `QueryLayerParams` / `AggregateLayerParams` types if Story 5 still references them at cutover.
  - **Removes from this module:** the `LAYERS` / `LayerKey` import and the `resolveLayerUrl` function — both belong to the v0.1 surface, and the new `src/tools/arcgis.ts` owns target resolution against `ORGS` + SGID registry.
  - **Leaves in temporarily:** `describeLayer`, `extractDomainValues`, `SCHEMA_CACHE`, `queryLayer`, `aggregateLayer`, `rawQuery` — these are still imported by `src/mcp.ts` until Story 5 cuts over. Story 5 deletes them.
- Update the import path in `src/mcp.ts` from `"./arcgis"` → `"./arcgis-client"` so the v0.1 tool registrations keep working through the rename. **This is the only mcp.ts edit in this story.** No new tools registered.

## Files deliberately untouched

- `src/geometry.ts` — unchanged. The new tool functions import `GeoJsonGeometry` from here.
- `src/registry.ts` — the v0.1 hand-curated 7-layer registry. Stays put; Story 5 deletes it.
- `src/mcp.ts` — the v0.1 tool definitions (`list_layers`, `describe_layer`, `query_layer`, `aggregate_layer`, `arcgis_query_raw`) stay registered for the duration of this story. Story 5 owns the swap.
- `src/index.ts` — Worker entrypoint, unchanged.

## Task list

1. `git mv src/arcgis.ts src/arcgis-client.ts`.
2. Update `src/mcp.ts`: change `from "./arcgis"` to `from "./arcgis-client"`. Run `npm run typecheck` — should pass green at this checkpoint.
3. In `src/arcgis-client.ts`, drop the `LAYERS` / `LayerKey` import and the `resolveLayerUrl` function. The v0.1 `queryLayer` / `aggregateLayer` / `describeLayer` / `rawQuery` functions still need URL resolution — temporarily inline a one-line `resolveLegacyLayer(layer: string)` that does what `resolveLayerUrl` did (URL passthrough else `LAYERS[layer].url`) so v0.1 tools keep working. Marked with a `// TODO Story 5: remove` comment.
4. Create `src/tools/arcgis.ts`. Import `arcgisJson`, `applySpatialFilter` from `../arcgis-client`, `GeoJsonGeometry` from `../geometry`, `ORGS` from `../registry/orgs`, and the SGID registry lookup from `../registry/sgid`.
5. Implement `resolveTarget(input): { url, label }`:
   - If `"url" in input` → return `{ url: input.url.replace(/\/+$/, ""), label: input.url }`.
   - Else look up `ORGS[input.org]`. If missing → throw `Unknown org '${input.org}'. Registered orgs: ${Object.keys(ORGS).join(", ")}.`
   - Look up the layer entry in the SGID registry by `(input.org, input.layer)`. If missing → throw `Unknown layer key '${input.org}/${input.layer}'. Call list_<category> for available layers, or find_layer to search the full UGRC Hub catalog.`
   - Return `{ url: ORGS[org].url_base + "/" + entry.service_path, label: `${input.org}/${input.layer}` }`.
6. Implement `arcgisQuery` — port `queryLayer` body verbatim, replacing the `resolveLayerUrl(params.layer)` call with `resolveTarget(input)`. The returned object's `layer` field becomes the `label` (so cataloged calls still echo `ugrc/wrlu`, URL calls echo the URL).
7. Implement `arcgisAggregate` — same port. The returned `layer` field similarly becomes `label`.
8. Implement `arcgisRaw` — port `rawQuery({ url, endpoint = "query", params })`. No registry resolution; `url` is required.
9. Catch-and-rethrow at the boundary in each function: prepend `[${label}] ` to error messages (or include in the geometry-too-large hint). For 404 / "Invalid URL" / "Layer does not exist" patterns, append `Hint: the registry URL may have drifted. Try find_layer({ query: "..." }) or update src/registry/sgid.ts via npm run sync-sgid-registry.`
10. Preserve the geometry-too-large branch verbatim: detect `/geometry/i` + `/(too\s+large|complex|exceed)/i` in the message and append the bbox hint.
11. Export the zod input schemas (see "Function signatures" below) for Story 5 to register against.
12. Export the candidate description strings (see "Tool description copy" below).
13. Run `npm run typecheck`. Hand-test by importing into a one-off script that calls `arcgisAggregate` against the v0.1 SubArea acceptance-test inputs.

## Function signatures

Sketch — types refer to Story 1's `OrgKey` (`keyof typeof ORGS`) and the per-org layer-key types from `src/registry/sgid.ts`.

```ts
import { z } from "zod";
import type { GeoJsonGeometry } from "../geometry";

// ─── Inputs ───────────────────────────────────────────────────────────────

const cataloged = z.object({
  org: z.enum(["ugrc"]),         // widened from OrgKey enum at registration time
  layer: z.string(),             // narrowed by per-org refinement in Story 5
});

const urlForm = z.object({
  url: z.string().url().describe("Full FeatureServer/MapServer layer URL ending in /N"),
});

const target = z.union([cataloged, urlForm]);

const queryFields = {
  where: z.string().default("1=1"),
  geometry: geometrySchema.optional(),
  bbox: bboxSchema.optional(),
  spatial_relationship: spatialRel.default("intersects"),
  out_fields: z.array(z.string()).default(["*"]),
  return_geometry: z.boolean().default(true),
  order_by: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(2000).default(500),
  offset: z.number().int().min(0).default(0),
  distinct: z.boolean().default(false),
};

const aggregateFields = {
  where: z.string().optional(),
  geometry: geometrySchema.optional(),
  bbox: bboxSchema.optional(),
  spatial_relationship: spatialRel.default("intersects"),
  group_by: z.array(z.string()).default([]),
  statistics: z.array(statSchema).min(1),
  order_by: z.array(z.string()).optional(),
  limit: z.number().int().min(1).default(1000),
};

export const arcgisQueryInput =
  z.union([cataloged.extend(queryFields), urlForm.extend(queryFields)]);

export const arcgisAggregateInput =
  z.union([cataloged.extend(aggregateFields), urlForm.extend(aggregateFields)]);

export const arcgisRawInput = z.object({
  url: z.string().url(),
  endpoint: z.string().default("query"),
  params: z.record(z.string(), z.unknown()),
});

// ─── Functions ────────────────────────────────────────────────────────────

export type ArcgisQueryInput = z.infer<typeof arcgisQueryInput>;
export type ArcgisAggregateInput = z.infer<typeof arcgisAggregateInput>;
export type ArcgisRawInput = z.infer<typeof arcgisRawInput>;

export interface ResolvedTarget { url: string; label: string }

export function resolveTarget(input: { org: string; layer: string } | { url: string }): ResolvedTarget;

export function arcgisQuery(input: ArcgisQueryInput): Promise<{
  features: unknown[];
  feature_count: number;
  exceeded_transfer_limit: boolean;
  next_offset: number | null;
  spatial_reference: "EPSG:4326";
  layer: string;          // == label
  where: string;
}>;

export function arcgisAggregate(input: ArcgisAggregateInput): Promise<{
  groups: Array<{ group: Record<string, unknown>; stats: Record<string, unknown> }>;
  total_groups: number;
  layer: string;          // == label
  where: string | null;
  spatial_filter: unknown;
}>;

export function arcgisRaw(input: ArcgisRawInput): Promise<unknown>;
```

The discriminated union at the zod level is deliberate. `z.union([cataloged.extend(...), urlForm.extend(...)])` gives the LLM two clearly-shaped alternatives in the parameter schema rather than a single shape with `org`/`layer`/`url` all optional and mutually-dependent.

## Tool description copy

These strings get registered in Story 5 verbatim. Per plan.md §"Per-tool description nudges", each query primitive opens with the same sentence.

**`arcgis_query`**

> First-class read path for any cataloged UGRC/SGID layer — handles GeoJSON, errors, pagination. Accepts EITHER `{ org, layer, ... }` (Tier 1: MCP resolves the URL via the ORGS registry — e.g. `{ org: "ugrc", layer: "wrlu" }`) OR `{ url, ... }` (Tier 2: pass the `url` returned by `find_layer`). GeoJSON in/out, WGS84 (EPSG:4326). Returns `features`, `exceeded_transfer_limit`, and `next_offset` for paging. Do not auto-paginate — chain calls yourself. Use after a `list_<category>` or `find_layer` call. Fall back to `arcgis_raw` only for endpoints this primitive can't express (queryAttachments, etc.) or non-UGRC services.

**`arcgis_aggregate`**

> First-class read path for any cataloged UGRC/SGID layer — handles GeoJSON, errors, pagination. Server-side groupBy + outStatistics; reach for this before paging features whenever you want headline numbers (acres by basin, count by class, etc.). Same dual-shape input as `arcgis_query` (`{ org, layer }` for cataloged layers, `{ url }` for layers from `find_layer`). May internally page across group results.

**`arcgis_raw`**

> Escape hatch — direct passthrough to any ArcGIS REST endpoint. Takes a full `url` and raw `params`; defaults `endpoint` to `query`. Use for: (a) non-UGRC services not registered in ORGS (county / federal / tribal — v0.3 work), or (b) endpoints `arcgis_query` can't model (`queryAttachments`, multipoint geometries, image export). Prefer `arcgis_query` / `arcgis_aggregate` for any cataloged UGRC layer.

## Functional requirements

From `docs/epic-v0.2.md` §"Functional requirements":

- **F6** — `arcgis_query` / `arcgis_aggregate` accept either `{ org, layer, ... }` or `{ url, ... }`. GeoJSON in/out, WGS84. Return shapes match v0.1 exactly (`features` / `exceeded_transfer_limit` / `next_offset`; `groups` / `total_groups`).
- **F7** — `arcgis_raw({ url, endpoint?, params })` remains the URL-passthrough escape hatch.

Story-specific (implied by plan.md §"Tool surface" → "Action: query primitives"):

- Tool descriptions follow the "First-class read path …" template and reference the `list_<category>` / `find_layer` upstream tools by name.
- Cataloged-input errors carry the `org/layer` label so URL drift is diagnosable (plan.md risk #5).

## Non-functional requirements

From `docs/epic-v0.2.md` §"Non-functional requirements":

- **N4** — Tool error messages for `{ org, layer }`-resolved URLs surface the resolved URL **and** the `org/layer` label so 404s tell the user which key drifted.
- **N5** — Geometry-too-large errors keep the v0.1 bbox-first hint verbatim.
- **N7** — Per-isolate `SCHEMA_CACHE` from v0.1 is preserved. (Story 2 leaves it in `src/arcgis-client.ts` for now; Story 5 relocates it alongside `describe_layer`.)
- **N9** — All v0.1 CLAUDE.md invariants hold: native `fetch` + `AbortSignal.timeout(30_000)`, POST `/query`, ArcGIS-200-with-error detection, hand-rolled GeoJSON↔esriJSON.
- **N10** — `npm run typecheck` passes at every commit boundary.

Preserved from CLAUDE.md:

- GeoJSON in/out is always WGS84. ArcGIS handles the EPSG:4326 → EPSG:26912 transform server-side via `inSR=4326` + `outSR=4326`.
- ArcGIS errors return HTTP 200 with `{"error": {"code", "message"}}` — must be detected explicitly (existing `arcgisJson` does this; do not regress).
- `spatial_relationship` accepts the friendly enum (`intersects` / `contains` / `within` / `crosses` / `touches` / `overlaps` / `envelope_intersects`) — never expose `esriSpatialRel*` to the agent. Translation happens in `spatialRelToEsri` (already in `src/geometry.ts`).
- POST `/query`, never GET — polygon-as-spatial-filter blows the 2KB GET ceiling.

## Acceptance criteria

1. `npm run typecheck` passes after the rename and after each new export.
2. Calling `arcgisAggregate({ org: "ugrc", layer: "wrlu", where: "SURV_YEAR=2023 AND Landuse='Agricultural'", group_by: ["SubArea"], statistics: [{ field: "ACRES", op: "sum", alias: "total_acres" }], order_by: ["total_acres DESC"], limit: 20 })` returns the same `{ groups, total_groups, layer: "ugrc/wrlu", where, spatial_filter }` shape as v0.1's `aggregateLayer` returned for the spec.md acceptance test, with Bear River / Weber / Jordan / Sevier / Uinta ranking near the top.
3. Calling `arcgisQuery({ org: "ugrc", layer: "wrlu", ... })` returns the v0.1 shape with `layer: "ugrc/wrlu"` echoed (not `layer: "wrlu"`).
4. Calling `arcgisQuery({ org: "ugrc", layer: "nope" })` returns an error whose message contains both `ugrc/nope` and `Call list_<category> for available layers`.
5. Calling `arcgisQuery({ url: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/WaterRelatedLandUse/FeatureServer/0", ... })` resolves the URL form without touching the registry and echoes the URL as the `layer` field.
6. Passing a state-sized polygon as `geometry` against a sub-state layer produces a geometry-too-large error whose message contains "pass a smaller polygon" / bbox hint (unchanged from v0.1).
7. `arcgisRaw({ url: "<some FeatureServer>", endpoint: "queryAttachments", params: { … } })` posts to `<url>/queryAttachments` and returns the parsed JSON unchanged.

## Verification steps

1. `npm run typecheck` — must pass.
2. `npm run dev` to spin up the Worker locally.
3. v0.1 tools (`query_layer`, `aggregate_layer`, `arcgis_query_raw`) still register and still work — exercise via `npx @modelcontextprotocol/inspector@latest` pointed at `http://127.0.0.1:8787/mcp`. This proves the rename + import path swap was clean.
4. From a one-off script (or Node REPL), import `arcgisQuery` / `arcgisAggregate` / `arcgisRaw` directly from `src/tools/arcgis.ts` and run the four acceptance scenarios above. They are not yet exposed via MCP — Story 5 wires them in — so direct function calls are the manual test.
5. Confirm the SubArea aggregation result matches the v0.1 output of the same call against `layer: "wrlu"` (run side-by-side if possible).

## Risks & mitigations

- **R5 — SGID URL drift (plan.md).** UGRC silently renames Feature Services. Story 2's mitigation: every cataloged-input error includes both the resolved URL and the `org/layer` label, plus a hint pointing to `find_layer` and `npm run sync-sgid-registry`. The label-in-errors discipline (the `resolveTarget` return + the boundary-catch in every function) is the load-bearing piece.
- **R6 — `arcgis_query` discoverability (plan.md).** The entire pivot rests on the model reaching for `arcgis_query` after `list_<category>` or `find_layer`. Mitigation in this story: the exported description strings open with the canonical "First-class read path …" sentence and explicitly name the upstream discovery tools. Story 5 reinforces with `McpServer.instructions` and the "Pair with …" suffix on every `list_<category>` description.

## Notes / references

- `docs/plan.md` §"Architecture", §"Tool surface" → "Action: query primitives (3 tools)", §"The model's typical flow", §"Phases" → Phase 2, §"Risks" #5 and #6.
- `docs/epic-v0.2.md` F6, F7, N4, N5, N7, N9, N10; critical-path diagram (S2 depends on S1 types, parallel with S3/S4, unblocks S5).
- `src/arcgis.ts` (pre-rename) — `arcgisJson`, `applySpatialFilter`, `queryLayer`, `aggregateLayer`, `rawQuery` are the bodies to port; `resolveLayerUrl` is the function to replace with `resolveTarget`.
- `src/geometry.ts` — unchanged; the new module imports `GeoJsonGeometry`, `spatialRelToEsri` from here.
- `src/mcp.ts` — only the import path changes in this story. The v0.1 tool registrations remain registered.
- `CLAUDE.md` §"Architecture" + cross-cutting invariants — the contract this story must keep intact.
