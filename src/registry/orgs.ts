import type { Org, OrgHandle } from "./types";

/**
 * Hand-maintained map of human-readable org handles to AGOL org metadata.
 *
 * v0.2 ships only "ugrc". v0.3 adds county/federal entries here — the query
 * API surface (arcgis_query({ org, layer })) doesn't change when new orgs are added.
 *
 * Never type the opaque agol_id by hand outside this file.
 */
export const ORGS = {
  ugrc: {
    name: "Utah Geospatial Resource Center (SGID)",
    agol_id: "99lidPhWCzftIe9K",
    url_base:
      "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services",
  },
  // v0.3 additions (schema is forward-compatible — just add entries):
  // beco: { name: "Box Elder County GIS", agol_id: "...", url_base: "..." },
  // slco: { name: "Salt Lake County GIS", agol_id: "...", url_base: "..." },
  // blm_utah: { name: "BLM Utah", agol_id: "...", url_base: "..." },
} as const satisfies Record<OrgHandle, Org>;

/**
 * Compose the full ArcGIS REST URL for a cataloged layer.
 *
 * Used by S2's arcgis_query/arcgis_aggregate ({org, layer} resolver) and
 * by S3's describe_layer cataloged-lookup branch. Centralised here so both
 * share one implementation.
 *
 * @param org    - org handle from ORGS, e.g. "ugrc"
 * @param service_path - path under url_base, e.g. "WaterRelatedLandUse/FeatureServer/0"
 * @returns full URL with no trailing slash
 */
export function resolveLayerUrl(org: OrgHandle, service_path: string): string {
  return `${ORGS[org].url_base}/${service_path}`;
}
