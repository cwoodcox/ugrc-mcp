/**
 * Hand-maintained enrichment sidecar for src/registry/sgid.ts.
 *
 * This file is the durable home for "things we've learned the hard way about
 * individual layers." It is merged into the generated registry at sync time
 * by scripts/sync-sgid-registry.ts.
 *
 * Add entries here whenever:
 *   - A layer has known gaps, gotchas, or LLM-hallucination traps.
 *   - A layer needs a stable key override (e.g. to match v0.1 keys).
 *   - An upstream entry has featureServiceId but no openSgid and needs manual routing.
 *
 * Keying convention: "${org}/${layer_key_override ?? derived_key}".
 * For entries before the key is known (e.g. manual_category entries with
 * featureServiceId-only upstream data), key by "${org}/<featureServiceId>".
 * The sync script resolves these at merge time.
 */

import type { EnrichmentEntry } from "../src/registry/types";

// ---------------------------------------------------------------------------
// Per-layer enrichment — keyed by "ugrc/<layer_key>"
// v0.1's seven layers are seeded here verbatim.
// ---------------------------------------------------------------------------

export const ENRICHMENT: Record<string, EnrichmentEntry> = {
  // ── Water Related Land Use (WRLU) ─────────────────────────────────────────
  // Upstream: openSgid = "planning.water_related_land_use"
  // v0.1 key: "wrlu" — keep stable via layer_key_override
  // manual_category overrides openSgid-derived "planning" → "farming" so that
  // list_farming returns this layer (plan.md AC #1).
  "ugrc/wrlu": {
    layer_key_override: "wrlu",
    manual_category: "farming",
    useful_fields: [
      "Landuse",
      "CropGroup",
      "Description",
      "IRR_Method",
      "Acres",
      "Basin",
      "SubArea",
      "SURV_YEAR",
    ],
    time_field: "SURV_YEAR",
    caveats: [
      "LUID is NOT stable across SURV_YEARs — filter by SURV_YEAR for time-series queries.",
      "Landuse value is 'Agricultural', not 'Agriculture' (common LLM hallucination).",
      "Latest vintage as of project memory is SURV_YEAR=2024.",
    ],
  },

  // ── Utah LIR Parcels (statewide) ──────────────────────────────────────────
  // Upstream: this is the STATEWIDE LIR layer (LIRParcels_Utah service).
  // The upstream metadata indexes per-county LIR parcels; the statewide roll-up
  // is a separate service not in downloadMetadata.ts. We include it via
  // manual_category so it stays in the registry.
  // v0.1 key: "parcels_lir"
  "ugrc/parcels_lir": {
    layer_key_override: "parcels_lir",
    manual_category: "cadastre",
    useful_fields: [
      "PARCEL_ID",
      "COUNTY_NAME",
      "PARCEL_ACRES",
      "PROP_CLASS",
      "OWN_TYPE",
      "TOTAL_MKT_VALUE",
      "LAND_MKT_VALUE",
      "TAXEXEMPT_TYPE",
    ],
    gaps: [
      "No owner names — those are county-held, not in SGID. v0.3 will surface county portals; for now, fall back to arcgis_raw against the county AGOL org.",
    ],
    caveats: ["Coverage is best-effort; check per-parcel asof date."],
  },

  // ── Utah Parcels Basic (statewide, geometry-only) ─────────────────────────
  // The statewide basic parcels layer (Parcels_Utah service) IS in upstream
  // metadata but is labeled "Utah Utah County Parcels" with openSgid
  // "cadastre.utah_county_parcels" — that's a per-county layer, not statewide.
  // The statewide roll-up (Parcels_Utah service) is a separate service.
  // We use layer_key_override to map it to the v0.1 key.
  // v0.1 key: "parcels_basic"
  "ugrc/parcels_basic": {
    layer_key_override: "parcels_basic",
    manual_category: "cadastre",
    caveats: [
      "Geometry-only — broader coverage than LIR but no assessor attributes.",
    ],
  },

  // ── Utah Watersheds Area (HUC) ────────────────────────────────────────────
  // Upstream: openSgid = "water.watersheds_area"
  // The sync derives key "watersheds_area" from openSgid; override to match v0.1.
  "ugrc/watersheds_huc12": {
    layer_key_override: "watersheds_huc12",
    useful_fields: [
      "HUC_12",
      "HUC_10",
      "HUC_8",
      "HU_12_NAME",
      "HU_10_NAME",
      "HU_8_NAME",
    ],
    caveats: [
      "Field names are underscored — HUC_8, HUC_10, HUC_12, HU_8_NAME, etc. (NOT HUC8/HUC12).",
      "Envelope filters drop inline spatialReference — pass envelopes as bbox arrays.",
      "Bonneville Basin HUC_8s define the Great Salt Lake drainage set.",
    ],
  },

  // ── Utah Agricultural Protection Areas ────────────────────────────────────
  // This service (AgriculturalProtectionAreas) is not in the upstream metadata.
  // Include via manual_category so it stays in the registry.
  // v0.1 key: "ag_protection_areas"
  "ugrc/ag_protection_areas": {
    layer_key_override: "ag_protection_areas",
    manual_category: "planning",
    caveats: [
      "Lots under voluntary 20-year ag covenants — treat as hard exclusion or special case for any conversion program.",
    ],
  },

  // ── Utah Land Ownership ───────────────────────────────────────────────────
  // Upstream: openSgid = "cadastre.land_ownership", but hosted on SITLA's server
  // (featureServiceHost = "https://gis.trustlands.utah.gov/mapping/rest/services/")
  // NOT on the UGRC AGOL org. Since v0.2 only includes 99lidPhWCzftIe9K-hosted
  // layers, this is injected as a manual entry with a known working URL.
  // v0.1 key: "land_ownership"
  "ugrc/land_ownership": {
    layer_key_override: "land_ownership",
    manual_category: "cadastre",
    useful_fields: ["OWNER", "ADMIN", "STATE_LGD"],
    caveats: [
      "BLM / SITLA / Tribal / State / Private classification.",
      "Hosted on SITLA's ArcGIS server, not the UGRC AGOL org — URL is gis.trustlands.utah.gov.",
    ],
  },

  // ── Utah Renewable Energy Zones — Solar ───────────────────────────────────
  // Upstream: openSgid = "energy.urez_phase_1_solar_zones" (featureServiceId = UREZPhase1_SolarZones)
  // Override key to match v0.1 "solar_zones".
  "ugrc/solar_zones": {
    layer_key_override: "solar_zones",
    caveats: [
      "First-pass solar-suitability screening polygons — not a permitting layer.",
    ],
  },

  // ---------------------------------------------------------------------------
  // UGRC-hosted featureServiceId-only entries (no openSgid) — manual routing
  // Keyed by "ugrc/<featureServiceId>" until the sync derives the layer key.
  // ---------------------------------------------------------------------------

  "ugrc/AlluvialFans": {
    manual_category: "geoscience",
  },

  "ugrc/StateFuelSites": {
    manual_category: "transportation",
  },

  "ugrc/Bikeways": {
    manual_category: "transportation",
  },

  "ugrc/Utah_Planned_Bikeways": {
    manual_category: "transportation",
  },
};

// ---------------------------------------------------------------------------
// Category-level overrides — blurb + category_gaps per category slug.
// Surfaced in list_<category> tool descriptions and catalog returns.
// ---------------------------------------------------------------------------

export const CATEGORY_OVERRIDES: Record<
  string,
  { blurb?: string; category_gaps?: string }
> = {
  cadastre: {
    blurb: "Parcels, taxation, zoning",
    category_gaps:
      "NOT owner names — those are county-held, not in SGID. v0.3 will surface county portals; for now, fall back to arcgis_raw against the relevant county AGOL org.",
  },
  water: {
    blurb: "Streams, lakes, hydrography",
  },
  farming: {
    blurb: "Land use, irrigation, ag protection",
  },
  planning: {
    blurb: "Land use planning, zoning, water-related land use",
  },
  boundaries: {
    blurb: "Administrative, political, and conservation boundaries",
  },
  society: {
    blurb: "Schools, libraries, public safety, social services",
  },
  indices: {
    blurb: "PLSS, addresses, section townships, geographic indices",
  },
  demographic: {
    blurb: "Population, census, demographic data",
  },
  energy: {
    blurb: "Energy infrastructure, renewable zones, oil and gas",
  },
  environment: {
    blurb: "Air quality, soils, environmental monitoring",
  },
  geoscience: {
    blurb: "Geology, hazards, soils, landslides",
  },
  political: {
    blurb: "Legislative districts, voting precincts, political boundaries",
  },
  recreation: {
    blurb: "Trails, parks, campgrounds, outdoor recreation",
  },
  location: {
    blurb: "Address points, place names, geographic reference",
  },
  economy: {
    blurb: "Business, enterprise zones, economic data",
  },
  health: {
    blurb: "Healthcare facilities, health districts, health data",
  },
  transportation: {
    blurb: "Roads, transit, bikeways, UDOT routes",
  },
  utilities: {
    blurb: "Electric, natural gas, communications infrastructure",
  },
  elevation: {
    blurb: "Digital elevation models, contours, LiDAR derivatives",
  },
  climate: {
    blurb: "Climate zones, weather stations",
  },
};
