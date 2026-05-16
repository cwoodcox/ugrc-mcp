import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { LAYERS } from "./registry";
import {
  aggregateLayer,
  describeLayer,
  queryLayer,
  rawQuery,
} from "./arcgis";

const coord = z.tuple([z.number(), z.number()]);

const geometrySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("Point"), coordinates: coord }),
    z.object({ type: z.literal("LineString"), coordinates: z.array(coord) }),
    z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(coord)) }),
    z.object({
      type: z.literal("MultiPolygon"),
      coordinates: z.array(z.array(z.array(coord))),
    }),
  ])
  .describe("GeoJSON Geometry in WGS84 (EPSG:4326). Mutually exclusive with bbox.");

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("[xmin, ymin, xmax, ymax] in WGS84.");

const spatialRel = z
  .enum([
    "intersects",
    "contains",
    "within",
    "crosses",
    "touches",
    "overlaps",
    "envelope_intersects",
  ])
  .default("intersects");

const statSchema = z.object({
  field: z.string(),
  op: z.enum(["sum", "count", "min", "max", "avg", "var", "stddev"]),
  alias: z.string(),
});

export class UgrcMcp extends McpAgent {
  server = new McpServer({
    name: "ugrc-mcp",
    version: "0.1.0",
  });

  async init() {
    this.server.tool(
      "list_layers",
      "Return the registry of available UGRC layers.",
      {},
      async () => {
        const layers = Object.entries(LAYERS).map(([key, l]) => ({
          key,
          name: l.name,
          steward: l.steward,
          notes: l.notes,
        }));
        return text({ layers });
      },
    );

    this.server.tool(
      "describe_layer",
      "Fetch and summarize the schema for a layer (fields, geometry type, extent, max record count, last edit date).",
      {
        layer: z
          .string()
          .describe("Registry key (e.g. 'wrlu') or full FeatureServer URL ending in /N"),
      },
      async ({ layer }) => text(await describeLayer(layer)),
    );

    this.server.tool(
      "query_layer",
      "Return features. GeoJSON in/out, WGS84. Workhorse tool — see spec.md §3 for full param semantics.",
      {
        layer: z.string(),
        where: z.string().default("1=1"),
        geometry: geometrySchema.optional(),
        bbox: bboxSchema.optional(),
        spatial_relationship: spatialRel,
        out_fields: z.array(z.string()).default(["*"]),
        return_geometry: z.boolean().default(true),
        order_by: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(2000).default(500),
        offset: z.number().int().min(0).default(0),
        distinct: z.boolean().default(false),
      },
      async (params) => text(await queryLayer(params)),
    );

    this.server.tool(
      "aggregate_layer",
      "Server-side aggregation (groupBy + outStatistics). Reach for this before paging through features for headline numbers. See spec.md §4.",
      {
        layer: z.string(),
        where: z.string().optional(),
        geometry: geometrySchema.optional(),
        bbox: bboxSchema.optional(),
        spatial_relationship: spatialRel,
        group_by: z.array(z.string()).default([]),
        statistics: z.array(statSchema).min(1),
        order_by: z.array(z.string()).optional(),
        limit: z.number().int().min(1).default(1000),
      },
      async (params) => text(await aggregateLayer(params)),
    );

    this.server.tool(
      "arcgis_query_raw",
      "Escape hatch. Direct passthrough to any ArcGIS REST /query (or queryAttachments, etc.) endpoint with arbitrary params.",
      {
        service_url: z
          .string()
          .url()
          .describe("Full URL ending in /FeatureServer/N or /MapServer/N"),
        endpoint: z.string().default("query"),
        params: z.record(z.string(), z.unknown()),
      },
      async ({ service_url, endpoint, params }) =>
        text(await rawQuery(service_url, endpoint, params)),
    );
  }
}

function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}
