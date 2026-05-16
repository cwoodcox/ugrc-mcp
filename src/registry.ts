export interface LayerInfo {
  url: string;
  name: string;
  steward: string;
  id_field?: string;
  useful_fields?: readonly string[];
  notes: string;
}

export const LAYERS = {
  wrlu: {
    url: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/WaterRelatedLandUse/FeatureServer/0",
    name: "Water Related Land Use",
    steward: "Utah Division of Water Resources",
    id_field: "LUID",
    useful_fields: ["Landuse", "CropGroup", "Description", "IRR_Method", "Acres", "Basin", "SubArea", "SURV_YEAR"],
    notes: "Annual polygons of crop/land-use + irrigation method. SURV_YEAR distinguishes vintages — filter on it for time-series. LUID is NOT stable across years.",
  },
  parcels_lir: {
    url: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/LIRParcels_Utah/FeatureServer/0",
    name: "Utah LIR Parcels",
    steward: "UGRC + counties",
    id_field: "PARCEL_ID",
    useful_fields: ["PARCEL_ID", "COUNTY_NAME", "PARCEL_ACRES", "PROP_CLASS", "OWN_TYPE", "TOTAL_MKT_VALUE", "LAND_MKT_VALUE", "TAXEXEMPT_TYPE"],
    notes: "Statewide parcels with assessor attributes. Coverage is best-effort; check per-parcel asof date.",
  },
  parcels_basic: {
    url: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/Parcels_Utah/FeatureServer/0",
    name: "Utah Parcels (basic)",
    steward: "UGRC + counties",
    id_field: "PARCEL_ID",
    notes: "Geometry-only parcels; broader coverage than LIR but no assessor attributes.",
  },
  watersheds_huc12: {
    url: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahWatershedsArea/FeatureServer/0",
    name: "Utah Watersheds Area",
    steward: "USGS / UGRC",
    id_field: "HUC_12",
    useful_fields: ["HUC_12", "HUC_10", "HUC_8", "HU_12_NAME", "HU_10_NAME", "HU_8_NAME"],
    notes: "Use HUC_8 / HUC_10 / HUC_12 to determine basin drainage (note the underscores — live field names differ from the spec's HUC12 form). Bonneville Basin HUC_8s are the GSL drainage set.",
  },
  ag_protection_areas: {
    url: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/AgriculturalProtectionAreas/FeatureServer/0",
    name: "Utah Agricultural Protection Areas",
    steward: "Utah Department of Agriculture and Food",
    notes: "Lots under voluntary 20-year ag covenants — a hard exclusion or special-case for any conversion program.",
  },
  land_ownership: {
    url: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/LandOwnership/FeatureServer/0",
    name: "Utah Land Ownership",
    steward: "UGRC",
    useful_fields: ["OWNER", "ADMIN", "STATE_LGD"],
    notes: "BLM / SITLA / Tribal / State / Private classification.",
  },
  solar_zones: {
    url: "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahSolarZones/FeatureServer/0",
    name: "Utah Renewable Energy Zones — Solar",
    steward: "Utah Office of Energy Development",
    notes: "First-pass solar-suitability screening polygons.",
  },
} as const satisfies Record<string, LayerInfo>;

export type LayerKey = keyof typeof LAYERS;
