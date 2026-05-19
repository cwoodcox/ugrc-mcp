/**
 * src/tools/arcgis.ts — v0.2 query primitives with discriminated { org, layer } | { url } input.
 *
 * Exports:
 *   arcgisQuery    — feature query, GeoJSON in/out
 *   arcgisAggregate — server-side groupBy + outStatistics
 *   arcgisRaw      — escape-hatch passthrough
 *   resolveTarget  — { org, layer } | { url } → { url, label }
 *   arcgisQueryInput / arcgisAggregateInput / arcgisRawInput — Zod schemas for Story 5
 *   ARCGIS_QUERY_DESCRIPTION / ARCGIS_AGGREGATE_DESCRIPTION / ARCGIS_RAW_DESCRIPTION — tool copy
 */

import { z } from "zod";
import { arcgisJson, applySpatialFilter } from "../arcgis-client";
import type { GeoJsonGeometry } from "../geometry";
import { ORGS, resolveLayerUrl } from "../registry/orgs";
import { SGID } from "../registry/sgid";
import type { SgidLayer } from "../registry/types";

// ─── Tool description strings (Story 5 registers these verbatim) ────────────

export const ARCGIS_QUERY_DESCRIPTION =
  "First-class read path for any cataloged UGRC/SGID layer — handles GeoJSON, errors, pagination. " +
  "Accepts EITHER `{ org, layer, ... }` (Tier 1: MCP resolves the URL via the ORGS registry — " +
  'e.g. `{ org: "ugrc", layer: "wrlu" }`) OR `{ url, ... }` (Tier 2: pass the `url` returned by ' +
  "`find_layer`). GeoJSON in/out, WGS84 (EPSG:4326). Returns `features`, `exceeded_transfer_limit`, " +
  "and `next_offset` for paging. Do not auto-paginate — chain calls yourself. Use after a " +
  "`list_<category>` or `find_layer` call. Fall back to `arcgis_raw` only for endpoints this " +
  "primitive can't express (queryAttachments, etc.) or non-UGRC services.";

export const ARCGIS_AGGREGATE_DESCRIPTION =
  "First-class read path for any cataloged UGRC/SGID layer — handles GeoJSON, errors, pagination. " +
  "Server-side groupBy + outStatistics; reach for this before paging features whenever you want " +
  "headline numbers (acres by basin, count by class, etc.). Same dual-shape input as `arcgis_query` " +
  "(`{ org, layer }` for cataloged layers, `{ url }` for layers from `find_layer`). " +
  "May internally page across group results.";

export const ARCGIS_RAW_DESCRIPTION =
  "Escape hatch — direct passthrough to any ArcGIS REST endpoint. Takes a full `url` and raw " +
  "`params`; defaults `endpoint` to `query`. Use for: (a) non-UGRC services not registered in " +
  "ORGS (county / federal / tribal — v0.3 work), or (b) endpoints `arcgis_query` can't model " +
  "(`queryAttachments`, multipoint geometries, image export). Prefer `arcgis_query` / " +
  "`arcgis_aggregate` for any cataloged UGRC layer.";

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const coord = z.tuple([z.number(), z.number()]);

const geometrySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("Point"), coordinates: coord }),
    z.object({ type: z.literal("LineString"), coordinates: z.array(coord) }),
    z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(coord)) }),
    z.object({
      type: z.literal("MultiPolygon"),
      coordinates: z.array(z.array(z.array(coord))),
    }),
  ])
  .describe("GeoJSON Geometry in WGS84 (EPSG:4326). Mutually exclusive with bbox.");

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("[xmin, ymin, xmax, ymax] in WGS84.");

const spatialRel = z
  .enum([
    "intersects",
    "contains",
    "within",
    "crosses",
    "touches",
    "overlaps",
    "envelope_intersects",
  ])
  .default("intersects");

const statSchema = z.object({
  field: z.string(),
  op: z.enum(["sum", "count", "min", "max", "avg", "var", "stddev"]),
  alias: z.string(),
});

const cataloged = z.object({
  org: z.enum(["ugrc"]),
  layer: z.string(),
});

const urlForm = z.object({
  url: z.string().url().describe("Full FeatureServer/MapServer layer URL ending in /N"),
});

const queryFields = {
  where: z.string().default("1=1"),
  geometry: geometrySchema.optional(),
  bbox: bboxSchema.optional(),
  spatial_relationship: spatialRel,
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
  spatial_relationship: spatialRel,
  group_by: z.array(z.string()).default([]),
  statistics: z.array(statSchema).min(1),
  order_by: z.array(z.string()).optional(),
  limit: z.number().int().min(1).default(1000),
};

export const arcgisQueryInput = z.union([
  cataloged.extend(queryFields),
  urlForm.extend(queryFields),
]);

export const arcgisAggregateInput = z.union([
  cataloged.extend(aggregateFields),
  urlForm.extend(aggregateFields),
]);

export const arcgisRawInput = z.object({
  url: z.string().url(),
  endpoint: z.string().default("query"),
  params: z.record(z.string(), z.unknown()),
});

// ─── TypeScript types ─────────────────────────────────────────────────────────

export type ArcgisQueryInput = z.infer<typeof arcgisQueryInput>;
export type ArcgisAggregateInput = z.infer<typeof arcgisAggregateInput>;
export type ArcgisRawInput = z.infer<typeof arcgisRawInput>;

export interface ResolvedTarget {
  url: string;
  label: string;
}

// ─── SGID lookup helper ───────────────────────────────────────────────────────

function findSgidLayer(org: string, layer: string): SgidLayer | undefined {
  for (const category of Object.values(SGID)) {
    for (const entry of category.layers) {
      if (entry.org === org && entry.layer === layer) {
        return entry;
      }
    }
  }
  return undefined;
}

// ─── resolveTarget ────────────────────────────────────────────────────────────

export function resolveTarget(input: { org: string; layer: string } | { url: string }): ResolvedTarget {
  if ("url" in input) {
    return { url: input.url.replace(/\/+$/, ""), label: input.url };
  }

  const { org, layer } = input;

  if (!(org in ORGS)) {
    throw new Error(
      `Unknown org '${org}'. Registered orgs: ${Object.keys(ORGS).join(", ")}.`,
    );
  }

  const entry = findSgidLayer(org, layer);
  if (!entry) {
    throw new Error(
      `Unknown layer key '${org}/${layer}'. Call list_<category> for available layers, or find_layer to search the full UGRC Hub catalog.`,
    );
  }

  // resolveLayerUrl handles absolute URLs (e.g. trustlands) transparently
  const url = resolveLayerUrl(org as "ugrc", entry.service_path);

  return { url, label: `${org}/${layer}` };
}

// ─── Error enrichment helpers ─────────────────────────────────────────────────

const GEO_TOO_LARGE_RE = /geometry/i;
const GEO_COMPLEX_RE = /(too\s+large|complex|exceed)/i;
const LAYER_NOT_FOUND_RE = /(404|invalid url|layer does not exist)/i;

const BBOX_HINT =
  "Hint: pass a smaller polygon as the spatial filter, or use bbox first to narrow the area before sending the precise polygon.";

const DRIFT_HINT =
  "Hint: the registry URL may have drifted. Try find_layer({ query: \"...\" }) or update src/registry/sgid.ts via npm run sync-sgid-registry.";

function enrichError(err: unknown, label: string): never {
  const raw = err instanceof Error ? err.message : String(err);
  let msg = `[${label}] ${raw}`;

  if (GEO_TOO_LARGE_RE.test(raw) && GEO_COMPLEX_RE.test(raw)) {
    msg = `${msg}\n\n${BBOX_HINT}`;
  } else if (LAYER_NOT_FOUND_RE.test(raw)) {
    msg = `${msg}\n\n${DRIFT_HINT}`;
  }

  throw new Error(msg);
}

// ─── arcgisQuery ─────────────────────────────────────────────────────────────

export async function arcgisQuery(input: ArcgisQueryInput): Promise<{
  features: unknown[];
  feature_count: number;
  exceeded_transfer_limit: boolean;
  next_offset: number | null;
  spatial_reference: "EPSG:4326";
  layer: string;
  where: string;
}> {
  const { url, label } = resolveTarget(input);

  const params = input as ArcgisQueryInput & {
    where: string;
    out_fields: string[];
    offset: number;
    limit: number;
    return_geometry: boolean;
    distinct: boolean;
    order_by?: string[];
    geometry?: GeoJsonGeometry;
    bbox?: [number, number, number, number];
    spatial_relationship: string;
  };

  const body = new URLSearchParams();
  body.set("f", "geojson");
  body.set("outSR", "4326");
  body.set("where", params.where);
  body.set("outFields", params.out_fields.join(","));
  body.set("resultOffset", String(params.offset));
  body.set("resultRecordCount", String(params.limit));
  // distinct values queries can't return geometry per ArcGIS REST contract
  body.set("returnGeometry", String(params.distinct ? false : params.return_geometry));
  if (params.order_by?.length) body.set("orderByFields", params.order_by.join(","));
  if (params.distinct) body.set("returnDistinctValues", "true");

  applySpatialFilter(body, params.geometry, params.bbox, params.spatial_relationship, "arcgis_query");

  let data: Record<string, unknown>;
  try {
    data = await arcgisJson(`${url}/query`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  } catch (err) {
    enrichError(err, label);
  }

  const features = (data!.features as Array<unknown>) ?? [];
  const exceeded = !!data!.exceededTransferLimit;

  return {
    features,
    feature_count: features.length,
    exceeded_transfer_limit: exceeded,
    next_offset: exceeded ? params.offset + features.length : null,
    spatial_reference: "EPSG:4326",
    layer: label,
    where: params.where,
  };
}

// ─── arcgisAggregate ─────────────────────────────────────────────────────────

export async function arcgisAggregate(input: ArcgisAggregateInput): Promise<{
  groups: Array<{ group: Record<string, unknown>; stats: Record<string, unknown> }>;
  total_groups: number;
  layer: string;
  where: string | null;
  spatial_filter: unknown;
}> {
  const { url, label } = resolveTarget(input);

  const params = input as ArcgisAggregateInput & {
    where?: string;
    group_by: string[];
    statistics: Array<{ field: string; op: string; alias: string }>;
    order_by?: string[];
    limit: number;
    geometry?: GeoJsonGeometry;
    bbox?: [number, number, number, number];
    spatial_relationship: string;
  };

  const outStatistics = params.statistics.map((s) => ({
    statisticType: s.op,
    onStatisticField: s.field,
    outStatisticFieldName: s.alias,
  }));

  const groupSet = new Set(params.group_by);
  const allRows: Array<{ group: Record<string, unknown>; stats: Record<string, unknown> }> = [];
  let offset = 0;
  // ArcGIS caps records per page; 2000 is the conventional max
  const pageSize = Math.min(params.limit, 2000);

  while (true) {
    const body = new URLSearchParams();
    body.set("f", "json");
    body.set("outSR", "4326");
    body.set("returnGeometry", "false");
    body.set("outStatistics", JSON.stringify(outStatistics));
    if (params.group_by.length) {
      body.set("groupByFieldsForStatistics", params.group_by.join(","));
    }
    if (params.where) body.set("where", params.where);
    if (params.order_by?.length) body.set("orderByFields", params.order_by.join(","));
    body.set("resultOffset", String(offset));
    body.set("resultRecordCount", String(pageSize));

    applySpatialFilter(
      body,
      params.geometry,
      params.bbox,
      params.spatial_relationship,
      "arcgis_aggregate",
    );

    let data: Record<string, unknown>;
    try {
      data = await arcgisJson(`${url}/query`, {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    } catch (err) {
      enrichError(err, label);
    }

    const features =
      (data!.features as Array<{ attributes?: Record<string, unknown> }>) ?? [];
    for (const feat of features) {
      const attrs = feat.attributes ?? {};
      const group: Record<string, unknown> = {};
      const stats: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (groupSet.has(k)) group[k] = v;
        else stats[k] = v;
      }
      allRows.push({ group, stats });
    }

    const exceeded = !!data!.exceededTransferLimit;
    if (!exceeded || features.length === 0 || allRows.length >= params.limit) break;
    offset += features.length;
  }

  return {
    groups: allRows.slice(0, params.limit),
    total_groups: Math.min(allRows.length, params.limit),
    layer: label,
    where: params.where ?? null,
    spatial_filter: params.geometry ?? (params.bbox ? { bbox: params.bbox } : null),
  };
}

// ─── arcgisRaw ───────────────────────────────────────────────────────────────

export async function arcgisRaw(input: ArcgisRawInput): Promise<unknown> {
  const { url, endpoint = "query", params } = input;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    body.set(
      k,
      typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : JSON.stringify(v),
    );
  }
  if (!body.has("f")) body.set("f", "json");
  return arcgisJson(`${url.replace(/\/+$/, "")}/${endpoint}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}
