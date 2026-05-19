#!/usr/bin/env tsx
/**
 * sync-sgid-registry.ts
 *
 * One-shot offline script: fetches agrc/gis.utah.gov's downloadMetadata.ts,
 * parses it, fetches per-layer pjson, merges hand-curated enrichment, and
 * writes src/registry/sgid.ts.
 *
 * Run with:  npm run sync-sgid-registry
 * Review:    git diff src/registry/sgid.ts
 * Commit:    git add src/registry/sgid.ts && git commit -m "sync: update SGID registry"
 *
 * ── Layer key slugification rule ─────────────────────────────────────────────
 * The layer key is derived from the openSgid suffix (the part after the dot),
 * e.g. "planning.water_related_land_use" → "water_related_land_use".
 *
 * Hand-overrides in scripts/enrichment.ts use a TWO-STEP lookup:
 *   1. Enrichment entries are keyed by "ugrc/<intended_final_key>".
 *   2. The sync script builds a reverse map: featureServiceId → EnrichmentEntry,
 *      using the layer_key_override field to match entries.
 *   3. If no reverse match, it also tries the derived openSgid key directly.
 *
 * This keeps the seven v0.1 keys stable:
 *   wrlu, parcels_lir, parcels_basic, watersheds_huc12,
 *   ag_protection_areas, land_ownership, solar_zones
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── Pinned upstream SHA ───────────────────────────────────────────────────────
 * Pin a known-good commit so the output is reproducible. Bump deliberately
 * (edit UPSTREAM_SHA below) when you want to pull in upstream changes.
 * This satisfies plan.md Risk #1 (upstream stability).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ENRICHMENT, CATEGORY_OVERRIDES } from "./enrichment";
import type { SgidLayer, SgidRegistry, EnrichmentEntry } from "../src/registry/types";

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Pinned commit SHA from agrc/gis.utah.gov for src/data/downloadMetadata.ts.
 * Bump this value deliberately when pulling upstream changes.
 */
const UPSTREAM_SHA = "2a736e7ab174ca0643b9e8bf73824e0323b5c646";
const UPSTREAM_REPO = "agrc/gis.utah.gov";
const UPSTREAM_PATH = "src/data/downloadMetadata.ts";
const UPSTREAM_URL = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_SHA}/${UPSTREAM_PATH}`;

/** Minimum number of entries expected in the upstream file before we trust the parse. */
const MIN_UPSTREAM_ENTRIES = 360;

/** UGRC AGOL org ID — only layers in this org are included in v0.2. */
const UGRC_ORG_ID = "99lidPhWCzftIe9K";
const UGRC_URL_BASE = `https://services1.arcgis.com/${UGRC_ORG_ID}/ArcGIS/rest/services`;

/** Skip these openSgid categories entirely (no queryable Feature Services). */
const SKIP_CATEGORIES = new Set(["example"]);

/** Concurrency limit for pjson fetches. */
const PJSON_CONCURRENCY = 10;

/** Max retries for 5xx errors (mirrors src/arcgis.ts pattern). */
const MAX_RETRIES = 3;

// ── Types for parsing ─────────────────────────────────────────────────────────

interface UpstreamEntry {
  entryName: string;
  itemId?: string;
  name?: string;
  featureServiceId?: string;
  featureServiceHost?: string;
  openSgid?: string;
  layerId?: number;
}

interface ParsedLayer {
  entryName: string;
  name: string;
  featureServiceId: string;
  serviceUrl: string;
  openSgid?: string;
  layerId: number;
  category: string;
  layerKey: string;
  enrichKey: string; // "ugrc/<layerKey>" — used to pull enrichment
}

// ── HTTP helper (mirrors src/arcgis.ts arcgisJson pattern) ────────────────────

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (response.status >= 500 && response.status < 600) {
      lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
      continue;
    }
    return response;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function fetchPjson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchWithRetry(`${url}?f=pjson`);
    if (!res.ok) {
      console.warn(`    [pjson] HTTP ${res.status} for ${url}`);
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    // ArcGIS errors arrive as HTTP 200 with { error: { code, message } }
    if (data && "error" in data) {
      const e = data.error as { code?: number; message?: string };
      console.warn(`    [pjson] ArcGIS error ${e.code}: ${e.message} — ${url}`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(
      `    [pjson] fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseDownloadMetadata(content: string): UpstreamEntry[] {
  const entries: UpstreamEntry[] = [];

  // The file is a TypeScript module with a single `export const dataPages = { ... }` object.
  // Each entry looks like:
  //   'Entry Name': {
  //     itemId: '...',
  //     name: '...',
  //     featureServiceId: 'ServiceName' | undefined,
  //     openSgid: 'category.layer_name' | undefined,
  //     layerId: 0,
  //   },
  //
  // We parse using regex over the block structure. The file is data-only — no logic.

  // Match each top-level key block: allow entries, numbers, and nested objects/arrays
  const blockRe = /'([^']+)':\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(content)) !== null) {
    const entryName = m[1];
    const block = m[2];

    const get = (key: string): string | undefined => {
      const r = new RegExp(`${key}:\\s*'([^']*)'`);
      const match = r.exec(block);
      return match?.[1];
    };

    const getNum = (key: string): number | undefined => {
      const r = new RegExp(`${key}:\\s*(\\d+)`);
      const match = r.exec(block);
      return match ? parseInt(match[1], 10) : undefined;
    };

    // Only extract string-valued fields (undefined values are excluded)
    const featureServiceId = get("featureServiceId");
    const openSgid = get("openSgid");

    entries.push({
      entryName,
      itemId: get("itemId"),
      name: get("name") ?? entryName,
      featureServiceId,
      featureServiceHost: get("featureServiceHost"),
      openSgid,
      layerId: getNum("layerId") ?? 0,
    });
  }

  return entries;
}

// ── Key derivation ────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ── Build enrichment reverse lookups ─────────────────────────────────────────

/**
 * Build a reverse lookup: featureServiceId → { enrichKey, entry }.
 *
 * The enrichment file is keyed by "ugrc/<intended_final_key>". To match
 * upstream entries by featureServiceId we need a reverse path.
 *
 * Strategy: for each enrichment entry that has a layer_key_override, that
 * override is the final key. We scan the upstream to find which featureServiceId
 * produces that derived key, then map featureServiceId → enrichEntry.
 *
 * Since we don't have the upstream at this point, we use a secondary lookup:
 * featureServiceId is stored directly as keys in ENRICHMENT for the manual-only
 * entries (e.g. "ugrc/AlluvialFans"). For override entries, we store a lookup
 * map built from SERVICE_ID_TO_ENRICH_KEY below.
 */

/**
 * Maps featureServiceId → enrichment key ("ugrc/<key>") for the v0.1 layers
 * whose keys are overridden. This is the bridge between stable upstream IDs
 * and the intended final keys.
 */
const SERVICE_ID_TO_ENRICH_KEY: Record<string, string> = {
  WaterRelatedLandUse: "ugrc/wrlu",
  UtahWatershedsArea: "ugrc/watersheds_huc12",
  UREZPhase1_SolarZones: "ugrc/solar_zones",
  // Manual layers (not in upstream) are handled separately via MANUAL_LAYERS
  // Land_Ownership uses featureServiceHost (non-UGRC) — handled via MANUAL_LAYERS
};

// ── pjson extraction ──────────────────────────────────────────────────────────

function extractPjsonMeta(data: Record<string, unknown>): {
  geometry_type?: string;
  last_edit_date?: string | null;
  max_record_count?: number;
  extent?: SgidLayer["extent"];
  field_summary?: SgidLayer["field_summary"];
} {
  const editingInfo = data.editingInfo as { dataLastEditDate?: number } | undefined;
  const lastEditMs = editingInfo?.dataLastEditDate;
  const last_edit_date = lastEditMs
    ? new Date(lastEditMs).toISOString().split("T")[0]
    : null;

  const geometry_type =
    typeof data.geometryType === "string" ? data.geometryType : undefined;
  const max_record_count =
    typeof data.maxRecordCount === "number" ? data.maxRecordCount : undefined;

  let extent: SgidLayer["extent"] | undefined;
  if (data.extent && typeof data.extent === "object") {
    const e = data.extent as Record<string, unknown>;
    if (
      typeof e.xmin === "number" &&
      typeof e.ymin === "number" &&
      typeof e.xmax === "number" &&
      typeof e.ymax === "number"
    ) {
      extent = {
        xmin: e.xmin,
        ymin: e.ymin,
        xmax: e.xmax,
        ymax: e.ymax,
      };
      if (e.spatialReference && typeof e.spatialReference === "object") {
        const sr = e.spatialReference as Record<string, unknown>;
        extent.spatialReference = {
          wkid: typeof sr.wkid === "number" ? sr.wkid : undefined,
          latestWkid:
            typeof sr.latestWkid === "number" ? sr.latestWkid : undefined,
        };
      }
    }
  }

  let field_summary: SgidLayer["field_summary"] | undefined;
  if (Array.isArray(data.fields)) {
    field_summary = (data.fields as Array<Record<string, unknown>>).map(
      (f) => ({
        name: String(f.name ?? ""),
        type: String(f.type ?? ""),
        alias: typeof f.alias === "string" ? f.alias : undefined,
      }),
    );
  }

  return { geometry_type, last_edit_date, max_record_count, extent, field_summary };
}

// ── Batched parallel fetch ────────────────────────────────────────────────────

async function batchedFetch<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ── Output rendering ──────────────────────────────────────────────────────────

function renderStringArray(
  arr: readonly string[] | undefined,
  indent: string,
): string {
  if (!arr || arr.length === 0) return "[]";
  const items = arr.map((s) => `${indent}  ${JSON.stringify(s)}`).join(",\n");
  return `[\n${items},\n${indent}]`;
}

function renderLayer(layer: SgidLayer, indent: string): string {
  const i2 = indent + "  ";
  const lines: string[] = ["{"];

  lines.push(`${i2}org: ${JSON.stringify(layer.org)},`);
  lines.push(`${i2}layer: ${JSON.stringify(layer.layer)},`);
  lines.push(`${i2}name: ${JSON.stringify(layer.name)},`);
  if (layer.steward !== undefined) {
    lines.push(`${i2}steward: ${JSON.stringify(layer.steward)},`);
  }
  lines.push(`${i2}service_path: ${JSON.stringify(layer.service_path)},`);
  if (layer.geometry_type !== undefined) {
    lines.push(`${i2}geometry_type: ${JSON.stringify(layer.geometry_type)},`);
  }
  lines.push(
    `${i2}last_edit_date: ${
      layer.last_edit_date === undefined
        ? "undefined"
        : JSON.stringify(layer.last_edit_date)
    },`,
  );
  if (layer.max_record_count !== undefined) {
    lines.push(`${i2}max_record_count: ${layer.max_record_count},`);
  }
  if (layer.extent !== undefined) {
    const e = layer.extent;
    const sr = e.spatialReference
      ? `, spatialReference: { wkid: ${e.spatialReference.wkid ?? "undefined"}, latestWkid: ${e.spatialReference.latestWkid ?? "undefined"} }`
      : "";
    lines.push(
      `${i2}extent: { xmin: ${e.xmin}, ymin: ${e.ymin}, xmax: ${e.xmax}, ymax: ${e.ymax}${sr} },`,
    );
  }
  if (layer.field_summary !== undefined && layer.field_summary.length > 0) {
    const fields = layer.field_summary
      .map((f) => {
        const alias =
          f.alias !== undefined ? `, alias: ${JSON.stringify(f.alias)}` : "";
        return `${i2}  { name: ${JSON.stringify(f.name)}, type: ${JSON.stringify(f.type)}${alias} }`;
      })
      .join(",\n");
    lines.push(`${i2}field_summary: [\n${fields},\n${i2}],`);
  }
  if (layer.useful_fields && layer.useful_fields.length > 0) {
    lines.push(
      `${i2}useful_fields: ${renderStringArray(layer.useful_fields, i2)},`,
    );
  }
  if (layer.gaps && layer.gaps.length > 0) {
    lines.push(`${i2}gaps: ${renderStringArray(layer.gaps, i2)},`);
  }
  if (layer.caveats && layer.caveats.length > 0) {
    lines.push(`${i2}caveats: ${renderStringArray(layer.caveats, i2)},`);
  }
  if (layer.time_field !== undefined) {
    lines.push(`${i2}time_field: ${JSON.stringify(layer.time_field)},`);
  }

  lines.push(`${indent}}`);
  return lines.join("\n");
}

function renderRegistry(registry: SgidRegistry, sha: string): string {
  const categories = Object.keys(registry).sort();
  const i = "  ";
  const i2 = "    ";
  const i3 = "      ";

  const catBlocks = categories.map((catKey) => {
    const cat = registry[catKey];
    const layersSorted = [...cat.layers].sort((a, b) =>
      a.layer.localeCompare(b.layer),
    );

    const layerLines = layersSorted
      .map((l) => `${i3}${renderLayer(l, i3)}`)
      .join(",\n");

    const lines: string[] = [`${i}${JSON.stringify(catKey)}: {`];
    lines.push(`${i2}name: ${JSON.stringify(cat.name)},`);
    if (cat.blurb !== undefined) {
      lines.push(`${i2}blurb: ${JSON.stringify(cat.blurb)},`);
    }
    if (cat.category_gaps !== undefined) {
      lines.push(`${i2}category_gaps: ${JSON.stringify(cat.category_gaps)},`);
    }
    if (layerLines) {
      lines.push(`${i2}layers: [\n${layerLines},\n${i2}],`);
    } else {
      lines.push(`${i2}layers: [],`);
    }
    lines.push(`${i}`+ "}");
    return lines.join("\n");
  });

  return [
    `// AUTOGENERATED by scripts/sync-sgid-registry.ts`,
    `// Source: ${UPSTREAM_REPO}@${sha}`,
    `// Do not edit by hand — run \`npm run sync-sgid-registry\` to regenerate.`,
    ``,
    `import type { SgidRegistry } from "./types";`,
    ``,
    `export const SGID: SgidRegistry = {`,
    catBlocks.join(",\n\n"),
    `} as const satisfies SgidRegistry;`,
    ``,
  ].join("\n");
}

// ── Manual layers not in upstream metadata ─────────────────────────────────────

/**
 * These v0.1 layers either aren't in agrc/gis.utah.gov's downloadMetadata.ts
 * or are hosted on a different server. We inject them manually so they
 * stay in the v0.2 registry under their stable v0.1 keys.
 *
 * Note: parcels_lir (LIRParcels_Utah) is not a valid UGRC AGOL service URL —
 * the statewide LIR roll-up uses a different service name. We include it as a
 * placeholder with last_edit_date=null since the pjson will 404.
 */
const MANUAL_LAYERS: Array<{
  layerKey: string;
  enrichKey: string;
  name: string;
  steward: string;
  serviceUrl: string;
  category: string;
}> = [
  {
    layerKey: "parcels_lir",
    enrichKey: "ugrc/parcels_lir",
    name: "Utah LIR Parcels",
    steward: "UGRC + counties",
    serviceUrl: `${UGRC_URL_BASE}/LIRParcels_Utah/FeatureServer/0`,
    category: "cadastre",
  },
  {
    layerKey: "parcels_basic",
    enrichKey: "ugrc/parcels_basic",
    name: "Utah Parcels (basic)",
    steward: "UGRC + counties",
    serviceUrl: `${UGRC_URL_BASE}/Parcels_Utah/FeatureServer/0`,
    category: "cadastre",
  },
  {
    layerKey: "ag_protection_areas",
    enrichKey: "ugrc/ag_protection_areas",
    name: "Utah Agricultural Protection Areas",
    steward: "Utah Department of Agriculture and Food",
    serviceUrl: `${UGRC_URL_BASE}/AgriculturalProtectionAreas/FeatureServer/0`,
    category: "planning",
  },
  {
    layerKey: "land_ownership",
    enrichKey: "ugrc/land_ownership",
    name: "Utah Land Ownership",
    steward: "UGRC / SITLA",
    serviceUrl:
      "https://gis.trustlands.utah.gov/mapping/rest/services/Land_Ownership/FeatureServer/0",
    category: "cadastre",
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\n── sync-sgid-registry ──────────────────────────────────────────`,
  );
  console.log(`Upstream: ${UPSTREAM_REPO}@${UPSTREAM_SHA}`);
  console.log(`Fetching ${UPSTREAM_URL}…`);

  // 1. Fetch upstream
  const content = await fetchText(UPSTREAM_URL);
  console.log(`  fetched ${content.length.toLocaleString()} bytes`);

  // 2. Parse
  const entries = parseDownloadMetadata(content);
  console.log(`  parsed ${entries.length} entries`);

  if (entries.length < MIN_UPSTREAM_ENTRIES) {
    throw new Error(
      `Parse assertion failed: got ${entries.length} entries, expected ≥${MIN_UPSTREAM_ENTRIES}. ` +
        `Upstream may have restructured. Inspect ${UPSTREAM_URL} and update the parser.`,
    );
  }

  // 3. Build enrichment lookup maps
  // Build map: featureServiceId → { enrichKey, entry } using SERVICE_ID_TO_ENRICH_KEY
  const fsIdToEnrichKey: Record<string, string> = { ...SERVICE_ID_TO_ENRICH_KEY };

  // Also add direct fsId → enrichKey mappings for entries keyed by fsId in ENRICHMENT
  for (const [enrichKey, entry] of Object.entries(ENRICHMENT)) {
    if (!enrichKey.startsWith("ugrc/")) continue;
    const keyPart = enrichKey.replace("ugrc/", "");
    // If this enrichment key directly matches a featureServiceId (e.g. "ugrc/AlluvialFans")
    // and has manual_category, it's a fsId-keyed entry
    if (entry.manual_category && !entry.layer_key_override) {
      fsIdToEnrichKey[keyPart] = enrichKey;
    }
  }

  // 4. Filter and classify entries
  let dropCount = 0;
  let manualPlacementCount = 0;
  const parsedLayers: ParsedLayer[] = [];
  const keysSeen = new Set<string>(); // for collision detection

  for (const entry of entries) {
    const { featureServiceId, openSgid, featureServiceHost } = entry;

    // Skip entries without a featureServiceId
    if (!featureServiceId) {
      dropCount++;
      continue;
    }

    // Determine the host — default is UGRC AGOL
    const host = featureServiceHost ?? UGRC_URL_BASE + "/";
    const isUgrcHosted = host.includes(UGRC_ORG_ID);

    // Determine category
    let category: string | undefined;
    if (openSgid) {
      const catSlug = openSgid.split(".")[0];
      if (SKIP_CATEGORIES.has(catSlug)) {
        dropCount++;
        continue;
      }
      category = catSlug;
    } else if (isUgrcHosted) {
      // UGRC-hosted but no openSgid — check if there's a manual_category in enrichment
      const enrichKeyForFs = fsIdToEnrichKey[featureServiceId];
      const enrichEntry = enrichKeyForFs ? ENRICHMENT[enrichKeyForFs] : undefined;
      if (enrichEntry?.manual_category) {
        category = enrichEntry.manual_category;
        manualPlacementCount++;
      } else {
        console.warn(
          `  [drop] no category for featureServiceId="${featureServiceId}" name="${entry.name}" — add to enrichment.ts`,
        );
        dropCount++;
        continue;
      }
    } else {
      // Non-UGRC host — drop (v0.2 only covers UGRC)
      dropCount++;
      continue;
    }

    // Build service URL
    let serviceUrl: string;
    if (isUgrcHosted) {
      serviceUrl = `${UGRC_URL_BASE}/${featureServiceId}/FeatureServer/${entry.layerId ?? 0}`;
    } else {
      serviceUrl = `${host.replace(/\/$/, "")}/${featureServiceId}/FeatureServer/${entry.layerId ?? 0}`;
    }

    // Derive enrichment key and final layer key
    let enrichKey: string;
    let layerKey: string;

    // Check SERVICE_ID_TO_ENRICH_KEY first (for overrides like wrlu, solar_zones, watersheds_huc12)
    const overrideEnrichKey = SERVICE_ID_TO_ENRICH_KEY[featureServiceId];
    if (overrideEnrichKey) {
      enrichKey = overrideEnrichKey;
      // The layer key is defined by the enrichment entry's layer_key_override
      const enrichEntry = ENRICHMENT[overrideEnrichKey];
      layerKey = enrichEntry?.layer_key_override ?? overrideEnrichKey.replace("ugrc/", "");
    } else if (openSgid) {
      // Derive from openSgid suffix: "category.layer_name" → "layer_name"
      const derivedKey = openSgid.split(".").pop() ?? slugify(featureServiceId);
      // Check if enrichment overrides this derived key
      const directEnrichKey = `ugrc/${derivedKey}`;
      const directEnrich = ENRICHMENT[directEnrichKey];
      layerKey = directEnrich?.layer_key_override ?? derivedKey;
      enrichKey = directEnrichKey;
    } else {
      // No openSgid — use the fsId-based enrichment key
      const fsEnrichKey = fsIdToEnrichKey[featureServiceId] ?? `ugrc/${slugify(featureServiceId)}`;
      const fsEnrich = ENRICHMENT[fsEnrichKey];
      layerKey = fsEnrich?.layer_key_override ?? slugify(featureServiceId);
      enrichKey = fsEnrichKey;
    }

    // Collision detection — prefer the entry we see first
    if (keysSeen.has(layerKey)) {
      console.warn(
        `  [warn] key collision "${layerKey}" for "${entry.entryName}" — skipping`,
      );
      dropCount++;
      continue;
    }
    keysSeen.add(layerKey);

    parsedLayers.push({
      entryName: entry.entryName,
      name: entry.name ?? entry.entryName,
      featureServiceId,
      serviceUrl,
      openSgid,
      layerId: entry.layerId ?? 0,
      category,
      layerKey,
      enrichKey,
    });
  }

  // 5. Add manual layers (v0.1 layers not in upstream metadata)
  for (const ml of MANUAL_LAYERS) {
    if (keysSeen.has(ml.layerKey)) {
      // Already picked up from upstream
      continue;
    }
    parsedLayers.push({
      entryName: ml.name,
      name: ml.name,
      featureServiceId: ml.layerKey,
      serviceUrl: ml.serviceUrl,
      openSgid: undefined,
      layerId: 0,
      category: ml.category,
      layerKey: ml.layerKey,
      enrichKey: ml.enrichKey,
    });
    keysSeen.add(ml.layerKey);
    manualPlacementCount++;
  }

  console.log(`\n  after filtering:`);
  console.log(`    surviving layers: ${parsedLayers.length}`);
  console.log(`    dropped:          ${dropCount}`);

  // 6. Per-layer pjson fetch
  console.log(
    `\n  fetching pjson for ${parsedLayers.length} layers (batches of ${PJSON_CONCURRENCY})…`,
  );

  let pjsonFailures = 0;
  const pjsonResults = await batchedFetch(
    parsedLayers,
    PJSON_CONCURRENCY,
    async (pl) => {
      const data = await fetchPjson(pl.serviceUrl);
      if (!data) pjsonFailures++;
      return data;
    },
  );

  console.log(`    pjson successes: ${parsedLayers.length - pjsonFailures}`);
  console.log(`    pjson failures:  ${pjsonFailures}`);

  // 7. Build SgidLayer objects with merged enrichment
  const registry: SgidRegistry = {};

  for (let i = 0; i < parsedLayers.length; i++) {
    const pl = parsedLayers[i];
    const pjson = pjsonResults[i];

    const pjsonMeta = pjson ? extractPjsonMeta(pjson) : {};

    // Derive service_path from the URL
    let service_path: string;
    if (pl.serviceUrl.startsWith(UGRC_URL_BASE)) {
      service_path = pl.serviceUrl.slice(UGRC_URL_BASE.length + 1);
    } else {
      // Non-UGRC hosted (e.g. land_ownership on SITLA) — store full URL
      service_path = pl.serviceUrl;
    }

    // Merge enrichment
    const enrich: EnrichmentEntry = ENRICHMENT[pl.enrichKey] ?? {};

    // Set last_edit_date: null if pjson failed (non-fatal)
    const last_edit_date =
      pjsonMeta.last_edit_date !== undefined ? pjsonMeta.last_edit_date : null;

    const layer: SgidLayer = {
      org: "ugrc",
      layer: pl.layerKey,
      name: pl.name,
      service_path,
      geometry_type: pjsonMeta.geometry_type,
      last_edit_date,
      max_record_count: pjsonMeta.max_record_count,
      extent: pjsonMeta.extent,
      field_summary: pjsonMeta.field_summary,
      ...(enrich.useful_fields ? { useful_fields: enrich.useful_fields } : {}),
      ...(enrich.gaps ? { gaps: enrich.gaps } : {}),
      ...(enrich.caveats ? { caveats: enrich.caveats } : {}),
      ...(enrich.time_field ? { time_field: enrich.time_field } : {}),
    };

    // Ensure category entry exists
    if (!registry[pl.category]) {
      const override = CATEGORY_OVERRIDES[pl.category] ?? {};
      registry[pl.category] = {
        name: pl.category,
        blurb: override.blurb,
        category_gaps: override.category_gaps,
        layers: [],
      };
    }
    registry[pl.category].layers.push(layer);
  }

  // 8. Print summary
  console.log(`\n── Summary ─────────────────────────────────────────────────────`);
  const categoriesSorted = Object.keys(registry).sort();
  let totalLayers = 0;
  for (const cat of categoriesSorted) {
    const count = registry[cat].layers.length;
    totalLayers += count;
    console.log(`  ${cat.padEnd(20)} ${count}`);
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${totalLayers}`);
  console.log(`  pjson failures: ${pjsonFailures}`);
  console.log(`  upstream drops: ${dropCount}`);
  console.log(`  manual placements: ${manualPlacementCount}`);
  console.log(`  categories: ${categoriesSorted.length}`);

  // 9. Write output
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const outDir = join(__dirname, "..", "src", "registry");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "sgid.ts");

  const output = renderRegistry(registry, UPSTREAM_SHA);
  writeFileSync(outPath, output, "utf8");
  console.log(`\n  written: ${outPath}`);
  console.log(`  (${output.length.toLocaleString()} bytes)`);
  console.log(`\n  Review with: git diff src/registry/sgid.ts`);
  console.log(`── done ────────────────────────────────────────────────────────\n`);
}

main().catch((err) => {
  console.error("sync-sgid-registry failed:", err);
  process.exit(1);
});
