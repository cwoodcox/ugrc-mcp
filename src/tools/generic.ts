/**
 * src/tools/generic.ts — v0.2 generic discovery + schema tools.
 *
 * Exports:
 *   describeLayer       — { org, layer } | { url } → merged catalog + live pjson
 *   listCapabilities    — 3-tier overview (categorized / find_layer / arcgis_raw)
 *   registerGenericTools(server) — wires both onto an McpServer (called from mcp.ts)
 *
 * Owns the per-isolate schema cache lifted from v0.1's src/arcgis.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { arcgisJson } from "../arcgis-client";
import { ORGS, resolveLayerUrl } from "../registry/orgs";
import { SGID } from "../registry/sgid";
import type { SgidLayer } from "../registry/types";

// ─── Tool descriptions (registered verbatim) ───────────────────────────────

export const LIST_CAPABILITIES_DESCRIPTION =
  "Overview of this MCP's coverage. Returns the three tiers (categorized SGID core via " +
  "`list_<category>` tools, uncategorized UGRC via `find_layer` live Hub search, " +
  "outside-UGRC via `arcgis_raw`), the list of categories with blurbs and layer counts, " +
  "mapserv tools, query primitives, and registered orgs. Call this first if you're unsure " +
  "what's available or after a long conversation that may have compressed the tool list. " +
  "Use the returned `discovery_tool` names to pick which `list_<category>` to call next.";

export const DESCRIBE_LAYER_DESCRIPTION =
  "Full schema for any SGID layer — fields with coded-value domains, current `last_edit_date` " +
  "(re-fetched live, not cataloged), geometry type, extent, max record count, plus hand-curated " +
  "`gaps` and `caveats` when known. Accepts either `{ org, layer }` for a cataloged Tier 1 layer " +
  "(e.g. `{ org: \"ugrc\", layer: \"wrlu\" }`) or `{ url }` for a layer surfaced by `find_layer`. " +
  "Use after `list_<category>` or `find_layer` to confirm freshness and learn quirks before " +
  "querying. Cached per Worker isolate so repeat calls within a session are free.";

// ─── Zod schemas ───────────────────────────────────────────────────────────

const cataloged = z.object({
  org: z.enum(["ugrc"]).describe("Registered org handle. v0.2 ships only \"ugrc\"."),
  layer: z.string().describe("Short layer key from a list_<category> tool (e.g. \"wrlu\")."),
});

const urlForm = z.object({
  url: z
    .string()
    .url()
    .describe("Full FeatureServer/MapServer layer URL ending in /N (typically from find_layer)."),
});

export const describeLayerInput = z.union([cataloged, urlForm]);
export type DescribeLayerInput = z.infer<typeof describeLayerInput>;

// ─── Per-isolate schema cache (lifted from v0.1 src/arcgis.ts) ─────────────

const SCHEMA_CACHE = new Map<string, unknown>();

// ─── SGID lookup helpers ───────────────────────────────────────────────────

function findSgidLayerByKey(
  org: string,
  layer: string,
): SgidLayer | undefined {
  for (const category of Object.values(SGID)) {
    for (const entry of category.layers) {
      if (entry.org === org && entry.layer === layer) return entry;
    }
  }
  return undefined;
}

function findSgidLayerByUrl(url: string): SgidLayer | undefined {
  const normalized = url.replace(/\/+$/, "");
  for (const category of Object.values(SGID)) {
    for (const entry of category.layers) {
      const cataloguedUrl = resolveLayerUrl(entry.org, entry.service_path).replace(/\/+$/, "");
      if (cataloguedUrl === normalized) return entry;
    }
  }
  return undefined;
}

function resolveDescribeTarget(input: DescribeLayerInput): {
  url: string;
  cataloged: SgidLayer | undefined;
  label: string;
} {
  if ("url" in input) {
    const url = input.url.replace(/\/+$/, "");
    return { url, cataloged: findSgidLayerByUrl(url), label: url };
  }
  const { org, layer } = input;
  if (!(org in ORGS)) {
    throw new Error(
      `Unknown org '${org}'. Registered orgs: ${Object.keys(ORGS).join(", ")}.`,
    );
  }
  const entry = findSgidLayerByKey(org, layer);
  if (!entry) {
    throw new Error(
      `Unknown layer '${org}/${layer}'. Try list_capabilities to see categorized layers, or find_layer({ query }) for the long tail.`,
    );
  }
  const url = resolveLayerUrl(org, entry.service_path).replace(/\/+$/, "");
  return { url, cataloged: entry, label: `${org}/${layer}` };
}

// ─── Live pjson fetch + field shaping ──────────────────────────────────────

function extractDomainValues(domain: unknown): string[] | undefined {
  if (!domain || typeof domain !== "object") return undefined;
  const d = domain as { type?: string; codedValues?: Array<{ name?: string }> };
  if (d.type !== "codedValue" || !Array.isArray(d.codedValues)) return undefined;
  return d.codedValues
    .map((cv) => cv.name)
    .filter((v): v is string => typeof v === "string");
}

function isoDate(epoch: number | undefined | null): string | null {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch).toISOString().slice(0, 10);
}

// ─── describeLayer ─────────────────────────────────────────────────────────

export async function describeLayer(input: DescribeLayerInput): Promise<unknown> {
  const { url, cataloged, label } = resolveDescribeTarget(input);

  const cached = SCHEMA_CACHE.get(url);
  if (cached) return cached;

  const data = await arcgisJson(`${url}?f=pjson`, { method: "GET" });

  const editingInfo = data.editingInfo as { dataLastEditDate?: number } | undefined;
  const liveLastEdit = isoDate(editingInfo?.dataLastEditDate);

  const fields = ((data.fields as Array<Record<string, unknown>>) ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    alias: f.alias,
    length: f.length,
    domain_values: extractDomainValues(f.domain),
  }));

  const description =
    typeof data.description === "string"
      ? (data.description as string).slice(0, 2000)
      : undefined;

  const merged = {
    // identity / catalog facts (when known)
    org: cataloged?.org,
    layer: cataloged?.layer,
    label,
    url,
    name: cataloged?.name ?? data.name,
    steward: cataloged?.steward,
    // live pjson — authoritative for freshness + full schema
    geometry_type: data.geometryType ?? cataloged?.geometry_type,
    max_record_count: data.maxRecordCount ?? cataloged?.max_record_count,
    last_edit_date: liveLastEdit ?? cataloged?.last_edit_date ?? null,
    extent: (data.extent as unknown) ?? cataloged?.extent,
    fields,
    description,
    // curated enrichment (only present for cataloged layers)
    useful_fields: cataloged?.useful_fields,
    gaps: cataloged?.gaps,
    caveats: cataloged?.caveats,
    time_field: cataloged?.time_field,
  };

  SCHEMA_CACHE.set(url, merged);
  return merged;
}

// ─── Category blurb / mapserv / search / primitives copy ───────────────────

const CATEGORY_BLURBS: Record<string, string> = {
  cadastre: "Parcels, taxation, zoning (NOT owner names — county-held)",
  society: "Schools, libraries, civic facilities",
  indices: "Cross-reference grids (PLSS, address, USNG)",
  boundaries: "Administrative, political, and conservation boundaries",
  demographic: "Census, population, language, employment",
  energy: "Power infrastructure, renewable zones, transmission",
  environment: "Conservation, protected areas, contamination sites",
  geoscience: "Geology, minerals, soils, faults",
  political: "Voting, legislative districts, election precincts",
  recreation: "Trails, parks, recreation amenities",
  location: "Place names, named features, points of interest",
  water: "Streams, lakes, hydrography",
  economy: "Industry, business, commerce",
  health: "Hospitals, clinics, public health facilities",
  transportation: "Roads, transit, airports, rail",
  planning: "Land use planning, zoning concepts",
  utilities: "Water, sewer, telecom infrastructure",
  elevation: "DEMs, contours, hypsography",
  farming: "Land use, irrigation, ag protection",
  climate: "Weather stations, climate observations",
};

const MAPSERV_OVERVIEW: Array<{ tool: string; purpose: string }> = [
  { tool: "geocode_address", purpose: "Address → coordinates" },
  { tool: "reverse_geocode", purpose: "Coordinates → address" },
  { tool: "geocode_milepost", purpose: "UDOT route + milepost → coordinates" },
  { tool: "reverse_milepost", purpose: "Coordinates → UDOT route + milepost" },
  {
    tool: "search_sgid_via_mapserv",
    purpose: "SQL-like search over mapserv-known SGID tables",
  },
  { tool: "list_sgid_tables", purpose: "Enumerate mapserv-known table names" },
  { tool: "list_sgid_fields", purpose: "Enumerate columns of a mapserv table" },
];

const SEARCH_OVERVIEW = [
  {
    tool: "find_layer",
    purpose:
      "Live full-text search across UGRC's full Hub catalog (~763 Feature Services)",
  },
];

const QUERY_PRIMITIVES = [
  {
    tool: "arcgis_query",
    purpose:
      "Read features from a cataloged layer ({ org, layer }) or a URL from find_layer ({ url })",
  },
  {
    tool: "arcgis_aggregate",
    purpose:
      "Server-side groupBy + statistics on a cataloged layer or URL",
  },
  {
    tool: "arcgis_raw",
    purpose:
      "Escape hatch — URL passthrough for non-UGRC endpoints or features arcgis_query doesn't model",
  },
];

// ─── listCapabilities ──────────────────────────────────────────────────────

export function listCapabilities(): {
  tiers: {
    categorized: { tool_prefix: string; layer_count: number; category_count: number };
    uncategorized: { tool: string; approx_count: number; source: string };
    outside_ugrc: { tool: string; note: string };
  };
  categories: Array<{
    name: string;
    discovery_tool: string;
    blurb: string;
    layer_count: number;
  }>;
  mapserv: typeof MAPSERV_OVERVIEW;
  search: typeof SEARCH_OVERVIEW;
  query_primitives: typeof QUERY_PRIMITIVES;
  registered_orgs: string[];
} {
  const categoryEntries = Object.entries(SGID).map(([key, entry]) => ({
    name: key,
    discovery_tool: `list_${key}`,
    blurb: entry.blurb ?? CATEGORY_BLURBS[key] ?? key,
    layer_count: entry.layers.length,
  }));
  categoryEntries.sort((a, b) => b.layer_count - a.layer_count);

  const totalLayers = categoryEntries.reduce((acc, c) => acc + c.layer_count, 0);

  return {
    tiers: {
      categorized: {
        tool_prefix: "list_<category>",
        layer_count: totalLayers,
        category_count: categoryEntries.length,
      },
      uncategorized: {
        tool: "find_layer",
        approx_count: 528,
        source: "ArcGIS Hub live search",
      },
      outside_ugrc: {
        tool: "arcgis_raw",
        note: "v0.3 will surface county/federal portals",
      },
    },
    categories: categoryEntries,
    mapserv: MAPSERV_OVERVIEW,
    search: SEARCH_OVERVIEW,
    query_primitives: QUERY_PRIMITIVES,
    registered_orgs: Object.keys(ORGS),
  };
}

// ─── Registration ──────────────────────────────────────────────────────────

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function registerGenericTools(server: McpServer): void {
  server.registerTool(
    "list_capabilities",
    {
      title: "Capabilities overview",
      description: LIST_CAPABILITIES_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text(listCapabilities()),
  );

  server.registerTool(
    "describe_layer",
    {
      title: "Describe layer schema",
      description: DESCRIBE_LAYER_DESCRIPTION,
      inputSchema: {
        org: z
          .enum(["ugrc"])
          .optional()
          .describe(
            "Registered org handle (v0.2: \"ugrc\"). Required with `layer`; omit if using `url`.",
          ),
        layer: z
          .string()
          .optional()
          .describe(
            "Short layer key from list_<category> (e.g. \"wrlu\"). Required with `org`; omit if using `url`.",
          ),
        url: z
          .string()
          .url()
          .optional()
          .describe(
            "Full FeatureServer/MapServer layer URL ending in /N (typically from find_layer). Mutually exclusive with { org, layer }.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (params) => {
      const input = normalizeDescribeInput(params);
      return text(await describeLayer(input));
    },
  );
}

function normalizeDescribeInput(params: {
  org?: "ugrc";
  layer?: string;
  url?: string;
}): DescribeLayerInput {
  if (params.url && (params.org || params.layer)) {
    throw new Error(
      "describe_layer: pass EITHER { url } OR { org, layer } — not both.",
    );
  }
  if (params.url) return { url: params.url };
  if (params.org && params.layer) {
    return { org: params.org, layer: params.layer };
  }
  throw new Error(
    "describe_layer: pass { org, layer } for a cataloged layer or { url } for a find_layer result.",
  );
}
