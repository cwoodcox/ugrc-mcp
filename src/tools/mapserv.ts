/**
 * src/tools/mapserv.ts
 *
 * 7 wrapper functions over the UGRC Web API (https://api.mapserv.utah.gov/)
 * plus the shared HTTP helper and the MCP tool registration function.
 *
 * Story 5 calls registerMapservTools(server, env) from mcp.ts.
 * This file has no direct dependency on S1/S2/S3.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ─── Module-level constants ────────────────────────────────────────────────

export const MAPSERV_BASE = "https://api.mapserv.utah.gov";

/**
 * Default Referer header value sent with every mapserv request. Mapserv keys
 * are issued with a referer allow-list pattern; the wrapper must send a value
 * that matches. Override per-deployment by setting UGRC_API_REFERER.
 */
export const MAPSERV_DEFAULT_REFERER =
  "https://ugrc-mcp.ompwwcx2yz.workers.dev/mcp";

/**
 * Verbatim error string returned (as a thrown Error) by every tool wrapper
 * when env.UGRC_API_KEY is unset or empty. Matches plan.md §"mapserv (7 tools)"
 * and story F8.1 exactly.
 */
export const MISSING_KEY_MSG =
  "Set UGRC_API_KEY via `wrangler secret put UGRC_API_KEY`. Request a key at developer.mapserv.utah.gov.";

// ─── Shared HTTP helper ────────────────────────────────────────────────────

/**
 * HTTP GET to the mapserv API.
 *
 * Mirrors the fetch + AbortSignal.timeout(30_000) + 5xx-retry pattern in
 * src/arcgis.ts. Differences from arcgisJson:
 *   - Always GET (mapserv has no POST query path).
 *   - mapserv uses proper 4xx for errors — no HTTP-200-with-error pattern.
 *   - apiKey is stripped from the logged URL to prevent accidental key leakage.
 *
 * @param path   Absolute path starting with "/" (e.g. "/api/v1/geocode/...").
 * @param query  Query params including apiKey. Never log this object.
 * @param env    Worker Env — UGRC_API_KEY read internally via the caller.
 */
async function mapservGet<T>(
  path: string,
  query: Record<string, string | number | undefined>,
  env: Env,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) {
      params.set(k, String(v));
    }
  }

  const url = `${MAPSERV_BASE}${path}?${params.toString()}`;
  const referer = env.UGRC_API_REFERER || MAPSERV_DEFAULT_REFERER;

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Referer: referer },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    // Retry on 5xx; surface 4xx immediately (bad key → 401/403, bad input → 400)
    if (response.status >= 500 && response.status < 600) {
      lastError = new Error(`mapserv HTTP ${response.status}: ${await response.text()}`);
      continue;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`mapserv HTTP ${response.status}: ${body}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error(
        `mapserv returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return data as T;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ─── Zod input schemas ─────────────────────────────────────────────────────

const SrSchema = z.number().int().positive().default(4326);

export const GeocodeAddressInput = z.object({
  street: z.string().min(1).describe("Street address (e.g. '326 East South Temple')."),
  zone: z.string().min(1).describe("City name or 5-digit zip code (e.g. 'Salt Lake City')."),
  spatial_reference: SrSchema.describe("Output EPSG code. Defaults to 4326 (WGS84)."),
  accept_score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Minimum acceptable match score (0–100). Low scores may be wrong addresses."),
});
export type GeocodeAddressInput = z.infer<typeof GeocodeAddressInput>;

export const ReverseGeocodeInput = z.object({
  x: z.number().describe("Longitude in the requested spatial reference (WGS84 by default)."),
  y: z.number().describe("Latitude in the requested spatial reference (WGS84 by default)."),
  spatial_reference: SrSchema.describe("EPSG code of the input coordinates. Defaults to 4326."),
  distance: z
    .number()
    .positive()
    .default(5)
    .describe("Search radius in meters. Defaults to 5 m."),
});
export type ReverseGeocodeInput = z.infer<typeof ReverseGeocodeInput>;

export const GeocodeMilepostInput = z.object({
  route: z.string().min(1).describe("UDOT route identifier (e.g. '0015' for I-15)."),
  milepost: z.number().nonnegative().describe("Milepost value along the route."),
  spatial_reference: SrSchema.describe("Output EPSG code. Defaults to 4326 (WGS84)."),
  side: z
    .enum(["increasing", "decreasing"])
    .optional()
    .describe("Milepost direction side. Omit for the nearest candidate."),
});
export type GeocodeMilepostInput = z.infer<typeof GeocodeMilepostInput>;

export const ReverseMilepostInput = z.object({
  x: z.number().describe("Longitude in the requested spatial reference (WGS84 by default)."),
  y: z.number().describe("Latitude in the requested spatial reference (WGS84 by default)."),
  spatial_reference: SrSchema.describe("EPSG code of the input coordinates. Defaults to 4326."),
  route: z
    .string()
    .min(1)
    .optional()
    .describe("Optional UDOT route filter (e.g. '0015'). Omit to find the nearest route."),
});
export type ReverseMilepostInput = z.infer<typeof ReverseMilepostInput>;

export const SearchSgidViaMapservInput = z.object({
  table_name: z
    .string()
    .min(1)
    .describe("SGID table name as known to mapserv (e.g. 'SGID.CADASTRE.Parcels_LIR')."),
  return_values: z
    .array(z.string().min(1))
    .min(1)
    .describe("Column names to return. Comma-joined into the URL path."),
  predicate: z
    .string()
    .optional()
    .describe("SQL-style WHERE predicate (e.g. \"COUNTY_NAME='BOX ELDER'\"). Omit for all rows."),
  geometry: z
    .unknown()
    .optional()
    .describe("GeoJSON geometry (WGS84) for spatial filtering."),
  spatial_reference: SrSchema.describe("Output EPSG code. Defaults to 4326 (WGS84)."),
  attribute_style: z
    .enum(["identical", "lower", "upper"])
    .optional()
    .describe("Case style for returned attribute names."),
});
export type SearchSgidViaMapservInput = z.infer<typeof SearchSgidViaMapservInput>;

export const ListSgidTablesInput = z.object({
  category: z
    .string()
    .optional()
    .describe(
      "Optional SGID category to filter by (e.g. 'cadastre'). Omit to list all tables.",
    ),
});
export type ListSgidTablesInput = z.infer<typeof ListSgidTablesInput>;

export const ListSgidFieldsInput = z.object({
  table_name: z
    .string()
    .min(1)
    .describe("SGID table name as known to mapserv (e.g. 'SGID.CADASTRE.Parcels_LIR')."),
});
export type ListSgidFieldsInput = z.infer<typeof ListSgidFieldsInput>;

// ─── Wrapper functions ─────────────────────────────────────────────────────

/**
 * Forward-geocode a Utah street address to a coordinate.
 *
 * Endpoint: GET /api/v1/geocode/{street}/{zone}
 */
export async function geocodeAddress(
  input: GeocodeAddressInput,
  env: Env,
): Promise<unknown> {
  if (!env.UGRC_API_KEY) throw new Error(MISSING_KEY_MSG);
  const path = `/api/v1/geocode/${encodeURIComponent(input.street)}/${encodeURIComponent(input.zone)}`;
  return mapservGet(
    path,
    {
      apiKey: env.UGRC_API_KEY,
      spatialReference: input.spatial_reference,
      ...(input.accept_score !== undefined ? { acceptScore: input.accept_score } : {}),
    },
    env,
  );
}

/**
 * Reverse-geocode a WGS84 coordinate to the nearest Utah street address.
 *
 * Endpoint: GET /api/v1/geocode/reverse/{x}/{y}
 */
export async function reverseGeocode(
  input: ReverseGeocodeInput,
  env: Env,
): Promise<unknown> {
  if (!env.UGRC_API_KEY) throw new Error(MISSING_KEY_MSG);
  const path = `/api/v1/geocode/reverse/${encodeURIComponent(String(input.x))}/${encodeURIComponent(String(input.y))}`;
  return mapservGet(
    path,
    {
      apiKey: env.UGRC_API_KEY,
      spatialReference: input.spatial_reference,
      distance: input.distance,
    },
    env,
  );
}

/**
 * Resolve a UDOT route + milepost to a WGS84 coordinate.
 *
 * Endpoint: GET /api/v1/geocode/milepost/{route}/{milepost}
 */
export async function geocodeMilepost(
  input: GeocodeMilepostInput,
  env: Env,
): Promise<unknown> {
  if (!env.UGRC_API_KEY) throw new Error(MISSING_KEY_MSG);
  const path = `/api/v1/geocode/milepost/${encodeURIComponent(input.route)}/${encodeURIComponent(String(input.milepost))}`;
  return mapservGet(
    path,
    {
      apiKey: env.UGRC_API_KEY,
      spatialReference: input.spatial_reference,
      ...(input.side !== undefined ? { side: input.side } : {}),
    },
    env,
  );
}

/**
 * Find the nearest UDOT route + milepost to a WGS84 coordinate.
 *
 * Endpoint: GET /api/v1/geocode/reversemilepost/{x}/{y}
 */
export async function reverseMilepost(
  input: ReverseMilepostInput,
  env: Env,
): Promise<unknown> {
  if (!env.UGRC_API_KEY) throw new Error(MISSING_KEY_MSG);
  const path = `/api/v1/geocode/reversemilepost/${encodeURIComponent(String(input.x))}/${encodeURIComponent(String(input.y))}`;
  return mapservGet(
    path,
    {
      apiKey: env.UGRC_API_KEY,
      spatialReference: input.spatial_reference,
      ...(input.route !== undefined ? { route: input.route } : {}),
    },
    env,
  );
}

/**
 * SQL-style attribute search against a single SGID table via the mapserv
 * `/search` endpoint.
 *
 * Endpoint: GET /api/v1/search/{tableName}/{returnValues}
 */
export async function searchSgidViaMapserv(
  input: SearchSgidViaMapservInput,
  env: Env,
): Promise<unknown> {
  if (!env.UGRC_API_KEY) throw new Error(MISSING_KEY_MSG);
  const returnValues = input.return_values.join(",");
  const path = `/api/v1/search/${encodeURIComponent(input.table_name)}/${encodeURIComponent(returnValues)}`;
  const query: Record<string, string | number | undefined> = {
    apiKey: env.UGRC_API_KEY,
    spatialReference: input.spatial_reference,
  };
  if (input.predicate !== undefined) query.predicate = input.predicate;
  if (input.geometry !== undefined) query.geometry = JSON.stringify(input.geometry);
  if (input.attribute_style !== undefined) query.attributeStyle = input.attribute_style;
  return mapservGet(path, query, env);
}

/**
 * Enumerate mapserv-recognized SGID table names, optionally filtered to one
 * SGID category.
 *
 * Endpoint: GET /api/v1/info/featureClassNames/{category?}
 */
export async function listSgidTables(
  input: ListSgidTablesInput,
  env: Env,
): Promise<unknown> {
  if (!env.UGRC_API_KEY) throw new Error(MISSING_KEY_MSG);
  return mapservGet(
    "/api/v1/info/featureClassNames",
    {
      apiKey: env.UGRC_API_KEY,
      ...(input.category !== undefined ? { category: input.category } : {}),
    },
    env,
  );
}

/**
 * Enumerate the columns of a single SGID table as known to mapserv.
 *
 * Endpoint: GET /api/v1/info/fieldnames/{tableName}
 */
export async function listSgidFields(
  input: ListSgidFieldsInput,
  env: Env,
): Promise<unknown> {
  if (!env.UGRC_API_KEY) throw new Error(MISSING_KEY_MSG);
  const path = `/api/v1/info/fieldnames/${encodeURIComponent(input.table_name)}`;
  return mapservGet(path, { apiKey: env.UGRC_API_KEY }, env);
}

// ─── MCP tool registration ─────────────────────────────────────────────────

/**
 * Register all 7 mapserv tools on the given McpServer.
 *
 * Story 5 imports this and calls it from mcp.ts. Keeping registration here
 * means Story 4 ships without any edit to mcp.ts; Story 5's diff is a single
 * import + call.
 *
 * @param server  The McpServer instance (from @modelcontextprotocol/sdk).
 * @param env     Worker Env — closed over by each tool handler.
 */
export function registerMapservTools(server: McpServer, env: Env): void {
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    "geocode_address",
    {
      title: "Geocode address",
      description:
        "Forward geocode a Utah street address to a coordinate. Returns location, match score, and address grid. Coordinates returned in WGS84 (EPSG:4326) by default.",
      inputSchema: GeocodeAddressInput.shape,
      annotations: readOnly,
    },
    async (input) => text(await geocodeAddress(input as GeocodeAddressInput, env)),
  );

  server.registerTool(
    "reverse_geocode",
    {
      title: "Reverse geocode",
      description:
        "Reverse geocode a WGS84 coordinate to the nearest Utah street address. Returns the matched address, grid, score, and offset distance.",
      inputSchema: ReverseGeocodeInput.shape,
      annotations: readOnly,
    },
    async (input) => text(await reverseGeocode(input as ReverseGeocodeInput, env)),
  );

  server.registerTool(
    "geocode_milepost",
    {
      title: "Geocode milepost",
      description:
        "Resolve a UDOT route + milepost to a WGS84 coordinate. Use for route-anchored locations (incident reports, asset inventories).",
      inputSchema: GeocodeMilepostInput.shape,
      annotations: readOnly,
    },
    async (input) => text(await geocodeMilepost(input as GeocodeMilepostInput, env)),
  );

  server.registerTool(
    "reverse_milepost",
    {
      title: "Reverse milepost",
      description:
        "Find the nearest UDOT route + milepost to a WGS84 coordinate. Optionally constrain to a specific route.",
      inputSchema: ReverseMilepostInput.shape,
      annotations: readOnly,
    },
    async (input) => text(await reverseMilepost(input as ReverseMilepostInput, env)),
  );

  server.registerTool(
    "search_sgid_via_mapserv",
    {
      title: "Mapserv attribute search",
      description:
        "SQL-style attribute search against a single SGID table via the mapserv `/search` endpoint. Use for predicates AGOL `/query` can't express 1:1; for typical reads, prefer `arcgis_query`.",
      inputSchema: SearchSgidViaMapservInput.shape,
      annotations: readOnly,
    },
    async (input) =>
      text(await searchSgidViaMapserv(input as SearchSgidViaMapservInput, env)),
  );

  server.registerTool(
    "list_sgid_tables",
    {
      title: "Mapserv: list tables",
      description:
        "List mapserv-recognized SGID table names, optionally filtered to one SGID category. Pair with `list_sgid_fields` then `search_sgid_via_mapserv`.",
      inputSchema: ListSgidTablesInput.shape,
      annotations: readOnly,
    },
    async (input) => text(await listSgidTables(input as ListSgidTablesInput, env)),
  );

  server.registerTool(
    "list_sgid_fields",
    {
      title: "Mapserv: list table fields",
      description:
        "List the columns of a single SGID table as known to mapserv. Use to build `return_values` and `predicate` for `search_sgid_via_mapserv`.",
      inputSchema: ListSgidFieldsInput.shape,
      annotations: readOnly,
    },
    async (input) => text(await listSgidFields(input as ListSgidFieldsInput, env)),
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}
