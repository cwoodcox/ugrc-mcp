import {
  bboxToEnvelope,
  geojsonToEsri,
  spatialRelToEsri,
  type GeoJsonGeometry,
} from "./geometry";

export async function arcgisJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
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

export function applySpatialFilter(
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
