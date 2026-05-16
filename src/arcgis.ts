import { LAYERS, type LayerKey } from "./registry";
import {
  bboxToEnvelope,
  geojsonToEsri,
  spatialRelToEsri,
  type GeoJsonGeometry,
} from "./geometry";

const SCHEMA_CACHE = new Map<string, unknown>();

export interface QueryLayerParams {
  layer: string;
  where: string;
  geometry?: GeoJsonGeometry;
  bbox?: [number, number, number, number];
  spatial_relationship: string;
  out_fields: string[];
  return_geometry: boolean;
  order_by?: string[];
  limit: number;
  offset: number;
  distinct: boolean;
}

export interface AggregateLayerParams {
  layer: string;
  where?: string;
  geometry?: GeoJsonGeometry;
  bbox?: [number, number, number, number];
  spatial_relationship: string;
  group_by: string[];
  statistics: Array<{
    field: string;
    op: "sum" | "count" | "min" | "max" | "avg" | "var" | "stddev";
    alias: string;
  }>;
  order_by?: string[];
  limit: number;
}

function resolveLayerUrl(layer: string): string {
  if (layer.startsWith("http://") || layer.startsWith("https://")) {
    return layer.replace(/\/+$/, "");
  }
  const entry = LAYERS[layer as LayerKey];
  if (!entry) {
    throw new Error(`Unknown layer key '${layer}'. Call list_layers for available keys.`);
  }
  return entry.url;
}

async function arcgisJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // 100ms, 200ms backoff between retries — keeps us well under the 30s timeout
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (response.status >= 500 && response.status < 600) {
      lastError = new Error(`ArcGIS HTTP ${response.status}: ${await response.text()}`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`ArcGIS HTTP ${response.status}: ${await response.text()}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error(
        `ArcGIS returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // ArcGIS errors arrive as HTTP 200 with { error: { code, message } }
    if (data && typeof data === "object" && "error" in data) {
      const e = (data as { error: { code?: number; message?: string } }).error;
      throw new Error(`ArcGIS error ${e.code ?? "?"}: ${e.message ?? "unknown"}`);
    }
    return data as Record<string, unknown>;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function applySpatialFilter(
  body: URLSearchParams,
  geometry: GeoJsonGeometry | undefined,
  bbox: [number, number, number, number] | undefined,
  spatialRelationship: string,
  toolName: string,
): void {
  if (geometry && bbox) {
    throw new Error(`${toolName}: geometry and bbox are mutually exclusive`);
  }
  if (!geometry && !bbox) return;
  const esri = geometry ? geojsonToEsri(geometry) : bboxToEnvelope(bbox!);
  body.set("geometry", JSON.stringify(esri.geometry));
  body.set("geometryType", esri.geometryType);
  body.set("inSR", String(esri.inSR));
  body.set("spatialRel", spatialRelToEsri(spatialRelationship));
}

export async function describeLayer(layer: string): Promise<unknown> {
  const url = resolveLayerUrl(layer);
  const cached = SCHEMA_CACHE.get(url);
  if (cached) return cached;

  const data = await arcgisJson(`${url}?f=pjson`, { method: "GET" });

  const summary = {
    layer,
    name: data.name,
    geometry_type: data.geometryType,
    max_record_count: data.maxRecordCount,
    data_last_edit_date:
      (data.editingInfo as { dataLastEditDate?: number } | undefined)?.dataLastEditDate,
    extent: data.extent,
    fields: ((data.fields as Array<Record<string, unknown>>) ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      alias: f.alias,
      length: f.length,
      domain_values: extractDomainValues(f.domain),
    })),
    description:
      typeof data.description === "string"
        ? (data.description as string).slice(0, 2000)
        : undefined,
  };

  SCHEMA_CACHE.set(url, summary);
  return summary;
}

function extractDomainValues(domain: unknown): string[] | undefined {
  if (!domain || typeof domain !== "object") return undefined;
  const d = domain as { type?: string; codedValues?: Array<{ name?: string }> };
  if (d.type !== "codedValue" || !Array.isArray(d.codedValues)) return undefined;
  return d.codedValues
    .map((cv) => cv.name)
    .filter((v): v is string => typeof v === "string");
}

export async function queryLayer(params: QueryLayerParams): Promise<unknown> {
  const url = resolveLayerUrl(params.layer);

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

  applySpatialFilter(body, params.geometry, params.bbox, params.spatial_relationship, "query_layer");

  let data: Record<string, unknown>;
  try {
    data = await arcgisJson(`${url}/query`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/geometry/i.test(msg) && /(too\s+large|complex|exceed)/i.test(msg)) {
      throw new Error(
        `${msg}\n\nHint: pass a smaller polygon as the spatial filter, or use bbox first to narrow the area before sending the precise polygon.`,
      );
    }
    throw err;
  }

  const features = (data.features as Array<unknown>) ?? [];
  const exceeded = !!data.exceededTransferLimit;

  return {
    features,
    feature_count: features.length,
    exceeded_transfer_limit: exceeded,
    next_offset: exceeded ? params.offset + features.length : null,
    spatial_reference: "EPSG:4326",
    layer: params.layer,
    where: params.where,
  };
}

export async function aggregateLayer(params: AggregateLayerParams): Promise<unknown> {
  const url = resolveLayerUrl(params.layer);

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
      "aggregate_layer",
    );

    const data = await arcgisJson(`${url}/query`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const features =
      (data.features as Array<{ attributes?: Record<string, unknown> }>) ?? [];
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

    const exceeded = !!data.exceededTransferLimit;
    if (!exceeded || features.length === 0 || allRows.length >= params.limit) break;
    offset += features.length;
  }

  return {
    groups: allRows.slice(0, params.limit),
    total_groups: Math.min(allRows.length, params.limit),
    layer: params.layer,
    where: params.where ?? null,
    spatial_filter: params.geometry ?? (params.bbox ? { bbox: params.bbox } : null),
  };
}

export async function rawQuery(
  serviceUrl: string,
  endpoint: string,
  params: Record<string, unknown>,
): Promise<unknown> {
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
  return arcgisJson(`${serviceUrl.replace(/\/+$/, "")}/${endpoint}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}
