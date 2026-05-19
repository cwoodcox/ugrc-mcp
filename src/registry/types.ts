// v0.2 registry types — shared across src/registry/* and src/tools/*.
// S2/S3/S5 import from here; do not break these shapes between stories.

/** Human-readable org handles. v0.2 ships only "ugrc"; extend the union in v0.3. */
export type OrgHandle = "ugrc";

/** One entry in the ORGS map. */
export interface Org {
  name: string;
  /** 16-character AGOL org ID — opaque, never typed by hand outside this file. */
  agol_id: string;
  /** Base URL for the org's ArcGIS REST service directory, no trailing slash. */
  url_base: string;
}

/** Abbreviated field descriptor stored in the registry (full schema via describe_layer). */
export interface FieldSummary {
  name: string;
  type: string;
  alias?: string;
}

/** One Tier-1 layer entry in the generated SGID registry. */
export interface SgidLayer {
  org: OrgHandle;
  /** Short snake_case key, unique within the org. Stable across syncs. */
  layer: string;
  /** Display name from upstream or pjson. */
  name: string;
  /** Owning agency / division. */
  steward?: string;
  /**
   * Path under the org's url_base, e.g. "WaterRelatedLandUse/FeatureServer/0".
   * Full URL = ORGS[org].url_base + "/" + service_path.
   */
  service_path: string;
  /** ArcGIS geometry type string, e.g. "esriGeometryPolygon". */
  geometry_type?: string;
  /** ISO date string or null if the pjson fetch failed. */
  last_edit_date?: string | null;
  max_record_count?: number;
  extent?: {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
    spatialReference?: { wkid?: number; latestWkid?: number };
  };
  /** Abbreviated field list — just name/type/alias. Full schema via describe_layer. */
  field_summary?: FieldSummary[];
  /** Fields the model should typically request, ordered by usefulness. */
  useful_fields?: readonly string[];
  /** What this layer does NOT have, with pointers. */
  gaps?: readonly string[];
  /** Known gotchas, data quirks, or common LLM hallucinations to avoid. */
  caveats?: readonly string[];
  /** The primary time/vintage field for temporal layers (e.g. "SURV_YEAR"). */
  time_field?: string;
}

/** One SGID category entry in the generated registry. */
export interface SgidCategory {
  name: string;
  blurb?: string;
  /** Category-level gaps surfaced in list_<category> tool description and return. */
  category_gaps?: string;
  layers: SgidLayer[];
}

/** The shape of the SGID export in src/registry/sgid.ts. Keyed by category slug. */
export type SgidRegistry = Record<string, SgidCategory>;

/**
 * Per-layer hand-curated overrides in scripts/enrichment.ts.
 * Keyed by "${org}/${layer}", e.g. "ugrc/wrlu".
 */
export interface EnrichmentEntry {
  useful_fields?: readonly string[];
  gaps?: readonly string[];
  caveats?: readonly string[];
  time_field?: string;
  /**
   * For the 21 upstream entries that have featureServiceId but no openSgid prefix —
   * route them into this category slug at sync time.
   */
  manual_category?: string;
  /**
   * Override the auto-derived layer key. Use for the v0.1 seven layers so their
   * keys stay stable (wrlu, parcels_lir, etc.).
   */
  layer_key_override?: string;
}
