/**
 * S3: Hub Search wrapper — find_layer.
 *
 * Exports registerHubSearchTool(server) — wraps the ArcGIS Hub Search v1
 * dataset-items endpoint, filtered to UGRC org + Feature Service, results
 * normalized and capped at 50. Story 5 calls this from mcp.ts.
 *
 * TODO: dedupe the fetch/retry helper with src/arcgis.ts (or arcgis-client.ts
 * after S2 lands) — mirrored locally for now per the story spec.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ORGS } from "../registry/orgs";

// ---------------------------------------------------------------------------
// Hub Search fetch helper (mirrors src/arcgis.ts retry pattern)
// ---------------------------------------------------------------------------

const HUB_SEARCH_BASE =
  "https://hub.arcgis.com/api/search/v1/collections/dataset/items";

const MAX_LIMIT = 50;

async function hubGet(url: string): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // 100ms, 200ms backoff — mirrors the v0.1 arcgis.ts pattern
      await new Promise<void>((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (response.status >= 500 && response.status < 600) {
      lastError = new Error(`Hub Search HTTP ${response.status}: ${await response.text()}`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Hub Search HTTP ${response.status}: ${await response.text()}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error(
        `Hub Search returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return data as Record<string, unknown>;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Hub item normalization
// ---------------------------------------------------------------------------

interface HubItem {
  name: string;
  description: string;
  url: string;
  last_edit_date: string | null;
  snippet: string;
  type: "Feature Service";
}

function truncate(s: string | undefined | null, maxLen: number): string {
  if (!s) return "";
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "…";
}

/**
 * Extract a usable Feature Service URL from a Hub item's properties.
 *
 * Hub items can have various URL shapes; we prefer:
 *   1. properties.url (the canonical service URL)
 *   2. properties.access_url / links[].href with type "related" for the FeatureServer
 *
 * We ensure the URL ends at /FeatureServer/0 when only a service root is provided.
 */
function extractServiceUrl(item: Record<string, unknown>): string {
  const props = (item.properties ?? {}) as Record<string, unknown>;

  // Prefer the explicit url field from Hub
  const rawUrl = typeof props.url === "string" ? props.url.trim() : "";
  if (rawUrl) {
    // If it already ends in /FeatureServer/N or /MapServer/N, use as-is
    if (/\/(FeatureServer|MapServer)\/\d+\s*$/.test(rawUrl)) {
      return rawUrl;
    }
    // If it ends in /FeatureServer or /MapServer (no layer index), append /0
    if (/\/(FeatureServer|MapServer)\s*$/.test(rawUrl)) {
      return rawUrl.replace(/\/+$/, "") + "/0";
    }
    // Otherwise return as-is (may be a service root — callers can append /FeatureServer/0)
    return rawUrl;
  }

  // Fallback: try links array for a FeatureServer link
  const links = Array.isArray(item.links) ? (item.links as Array<Record<string, unknown>>) : [];
  for (const link of links) {
    const href = typeof link.href === "string" ? link.href.trim() : "";
    if (/FeatureServer/i.test(href)) {
      if (/\/\d+\s*$/.test(href)) return href;
      return href.replace(/\/+$/, "") + "/0";
    }
  }

  return "";
}

function normalizeHubItem(item: Record<string, unknown>): HubItem {
  // Hub Search v1: metadata is in `properties`, not on the item root
  const props = (item.properties ?? {}) as Record<string, unknown>;

  // title: Hub puts it in properties.title
  const title =
    typeof props.title === "string"
      ? props.title
      : typeof props.name === "string"
        ? props.name
        : "";

  // description: Hub puts full description in properties.description;
  // properties.snippet is a short summary (~256 chars)
  const rawDesc =
    typeof props.description === "string"
      ? props.description
      : "";

  const description = truncate(rawDesc, 500);

  const url = extractServiceUrl(item);

  // ISO date from properties.modified (milliseconds epoch or ISO string)
  let last_edit_date: string | null = null;
  const modified = props.modified;
  if (typeof modified === "number" && modified > 0) {
    last_edit_date = new Date(modified).toISOString().slice(0, 10);
  } else if (typeof modified === "string" && modified.trim()) {
    last_edit_date = modified.trim();
  }

  // snippet: prefer properties.snippet (Hub's own short summary), else first 200 chars of description
  let snippet =
    typeof props.snippet === "string" && props.snippet.trim()
      ? truncate(props.snippet, 200)
      : truncate(rawDesc, 200);

  return {
    name: title,
    description,
    url,
    last_edit_date,
    snippet,
    type: "Feature Service",
  };
}

// ---------------------------------------------------------------------------
// Core findLayer function
// ---------------------------------------------------------------------------

interface FindLayerParams {
  query: string;
  limit?: number;
}

interface FindLayerResult {
  query: string;
  capped_at: number;
  total_returned: number;
  results: HubItem[];
}

/**
 * Search UGRC's ArcGIS Hub catalog for Feature Services matching a free-text query.
 *
 * Capped at 50 results (N3 / R8 — Hub's numberMatched is unreliable; don't paginate).
 *
 * Hub Search v1 uses two separate parameters:
 *   - `filter` for structured predicates (org, type) — SQL-like syntax
 *   - `q`      for free-text search — standard OGC API Records text search
 */
export async function findLayer({ query, limit }: FindLayerParams): Promise<FindLayerResult> {
  const clampedLimit = Math.min(limit ?? 25, MAX_LIMIT);

  // Structured filter: restrict to UGRC org + Feature Service type
  const filter = `orgid='${ORGS.ugrc.agol_id}' AND type='Feature Service'`;

  const params = new URLSearchParams({
    filter,
    q: query.trim(),
    limit: String(clampedLimit),
  });

  const url = `${HUB_SEARCH_BASE}?${params.toString()}`;
  const data = await hubGet(url);

  const rawFeatures = Array.isArray(data.features)
    ? (data.features as Array<Record<string, unknown>>)
    : [];

  const results = rawFeatures.map(normalizeHubItem);

  return {
    query,
    capped_at: MAX_LIMIT,
    total_returned: results.length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Exported registration function
// ---------------------------------------------------------------------------

function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

/**
 * Register the find_layer tool.
 * Called by Story 5 from mcp.ts — do not call from mcp.ts in this story.
 */
export function registerHubSearchTool(server: McpServer): void {
  server.tool(
    "find_layer",
    // Full description verbatim from story spec §"Tool description copy"
    "Search UGRC's full ArcGIS Hub catalog live (~763 Feature Services) for layers matching a free-text query. " +
      "Use this **Tier 2** entry point when no `list_<category>` tool surfaces the layer you need — " +
      "there are ~528 UGRC services that aren't in the categorized core. " +
      "Returns matching layers with `{ name, description, url, last_edit_date, snippet, type }`. " +
      "The returned `url` is ready to pass directly to `arcgis_query({ url, ... })` / `arcgis_aggregate({ url, ... })`. " +
      "Results are capped at 50. " +
      "Example: `find_layer({ query: \"springs\" })` surfaces the NHD Springs layer for hydrography questions `list_water` (6 layers) doesn't cover.",
    {
      query: z.string().min(1).describe("Free-text search query, e.g. \"springs\" or \"parcels salt lake\""),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(25)
        .describe("Maximum results to return (1–50, default 25)."),
    },
    async (params) => text(await findLayer(params)),
  );
}
