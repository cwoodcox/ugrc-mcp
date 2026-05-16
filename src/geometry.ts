// GeoJSON ↔ esriJSON conversion for the geometry types used by query_layer /
// aggregate_layer. Polygon ring orientation differs: GeoJSON (RFC 7946) uses
// CCW exterior + CW holes, esriJSON uses CW exterior + CCW holes. ArcGIS is
// forgiving on input but worth knowing if you ever consume esriJSON output.

export type GeoJsonGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

export interface EsriGeometry {
  geometry: unknown;
  geometryType:
    | "esriGeometryPoint"
    | "esriGeometryPolyline"
    | "esriGeometryPolygon"
    | "esriGeometryEnvelope";
  inSR: number;
}

// ArcGIS reads the input spatial reference from the `inSR` form param.
// Including a `spatialReference` inside the geometry JSON conflicts with
// `inSR` on some endpoints and yields a generic 400 — leave it off.
export function geojsonToEsri(g: GeoJsonGeometry): EsriGeometry {
  switch (g.type) {
    case "Point":
      return {
        geometry: { x: g.coordinates[0], y: g.coordinates[1] },
        geometryType: "esriGeometryPoint",
        inSR: 4326,
      };
    case "LineString":
      return {
        geometry: { paths: [g.coordinates] },
        geometryType: "esriGeometryPolyline",
        inSR: 4326,
      };
    case "Polygon":
      return {
        geometry: { rings: g.coordinates },
        geometryType: "esriGeometryPolygon",
        inSR: 4326,
      };
    case "MultiPolygon":
      return {
        geometry: { rings: g.coordinates.flat(1) },
        geometryType: "esriGeometryPolygon",
        inSR: 4326,
      };
  }
}

export function bboxToEnvelope(bbox: [number, number, number, number]): EsriGeometry {
  const [xmin, ymin, xmax, ymax] = bbox;
  return {
    geometry: { xmin, ymin, xmax, ymax },
    geometryType: "esriGeometryEnvelope",
    inSR: 4326,
  };
}

const SPATIAL_REL_MAP: Record<string, string> = {
  intersects: "esriSpatialRelIntersects",
  contains: "esriSpatialRelContains",
  within: "esriSpatialRelWithin",
  crosses: "esriSpatialRelCrosses",
  touches: "esriSpatialRelTouches",
  overlaps: "esriSpatialRelOverlaps",
  envelope_intersects: "esriSpatialRelEnvelopeIntersects",
};

export function spatialRelToEsri(rel: string): string {
  const mapped = SPATIAL_REL_MAP[rel];
  if (!mapped) throw new Error(`Unknown spatial_relationship '${rel}'`);
  return mapped;
}
