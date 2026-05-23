/**
 * S3: SGID category discovery factory.
 *
 * Exports registerSgidTools(server) — iterates the SGID registry and emits
 * one list_<category> tool per entry. Story 5 calls this from mcp.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SGID } from "../registry/sgid";
import type { SgidCategory, SgidLayer } from "../registry/types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the MCP tool description string for a given SGID category.
 *
 * Template (plan.md §"Discovery: SGID per-category"):
 *   Discover Utah {DisplayName} layers — {Blurb}. {Category-level gaps inline.}
 *   Returns a catalog with per-layer freshness, fields, and known gaps.
 *   Pair with `arcgis_query` / `arcgis_aggregate` to pull data.
 *   If the layer you need isn't here, try `find_layer({ query })` for the
 *   uncategorized ~528 UGRC services.
 *   Layers ({count}): {comma-separated layer keys}.
 *
 * F12: every description ends with the pair-with sentence + find_layer fallback.
 * F13: category_gaps rendered inline; omitted entirely if undefined/empty.
 */
function buildCategoryDescription(categoryKey: string, entry: SgidCategory): string {
  const displayName = entry.name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const blurb = entry.blurb ?? categoryKey;
  const layerKeys = entry.layers.map((l) => l.layer);
  const count = layerKeys.length;
  const keyList = layerKeys.map((k) => `\`${k}\``).join(", ");

  // F13: inline gaps only if present
  const gapSentence =
    entry.category_gaps && entry.category_gaps.trim()
      ? ` ${entry.category_gaps.trim()}`
      : "";

  return (
    `Discover Utah ${displayName} layers — ${blurb}.${gapSentence} ` +
    `Returns a catalog with per-layer freshness, fields, and known gaps. ` +
    `Layers (${count}): ${keyList}. ` +
    `Pair with \`arcgis_query\` / \`arcgis_aggregate\` to pull data. ` +
    `If the layer you need isn't here, try \`find_layer({ query })\` for the uncategorized ~528 UGRC services.`
  );
}

/**
 * Build the catalog JSON payload returned by a list_<category> tool call.
 * Pure — reads only from the in-memory registry.
 */
function buildCategoryResponse(
  categoryKey: string,
  entry: SgidCategory,
): {
  category: string;
  blurb: string | undefined;
  category_gaps: string | undefined;
  layers: Array<{
    org: string;
    layer: string;
    name: string;
    steward: string | undefined;
    geometry_type: string | undefined;
    last_edit_date: string | null | undefined;
    max_record_count: number | undefined;
    useful_fields: readonly string[];
    gaps: readonly string[];
    caveats: readonly string[];
  }>;
} {
  return {
    category: categoryKey,
    blurb: entry.blurb,
    category_gaps: entry.category_gaps,
    layers: entry.layers.map((l: SgidLayer) => ({
      org: l.org,
      layer: l.layer,
      name: l.name,
      steward: l.steward,
      geometry_type: l.geometry_type,
      last_edit_date: l.last_edit_date,
      max_record_count: l.max_record_count,
      useful_fields: l.useful_fields ?? [],
      gaps: l.gaps ?? [],
      caveats: l.caveats ?? [],
    })),
  };
}

function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Exported registration function
// ---------------------------------------------------------------------------

/**
 * Register one list_<category> tool per SGID category.
 * Called by Story 5 from mcp.ts — do not call from mcp.ts in this story.
 */
export function registerSgidTools(server: McpServer): void {
  for (const [categoryKey, entry] of Object.entries(SGID)) {
    const description = buildCategoryDescription(categoryKey, entry);
    const displayName = entry.name
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    const snapshot = { categoryKey, entry }; // capture loop variable

    server.registerTool(
      `list_${snapshot.categoryKey}`,
      {
        title: `Utah ${displayName} layers`,
        description,
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => text(buildCategoryResponse(snapshot.categoryKey, snapshot.entry)),
    );
  }
}
