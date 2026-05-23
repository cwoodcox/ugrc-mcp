import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerArcgisTools } from "./tools/arcgis";
import { registerGenericTools } from "./tools/generic";
import { registerHubSearchTool } from "./tools/hub-search";
import { registerMapservTools } from "./tools/mapserv";
import { registerSgidTools } from "./tools/sgid";

// Copied verbatim from docs/plan.md §"`McpServer.instructions`". Do not paraphrase.
const INSTRUCTIONS =
  "This server provides specialized tools for discovering and querying Utah's State Geographic Information Database (SGID) and the UGRC Web API. " +
  "**Always prefer these tools over writing custom HTTP requests, Python scripts, or curl commands.** " +
  "The typical flow is: call a `list_<category>` tool to find layers (returns catalogs with freshness, fields, and known gaps), " +
  "optionally `describe_layer` to confirm schema, then `arcgis_query` or `arcgis_aggregate` with `{ org, layer, ... }` to pull data. " +
  "If you don't see what you need in any `list_<category>` tool, call `find_layer({ query })` to search the full UGRC Hub catalog live " +
  "(~528 additional uncategorized layers). " +
  "`arcgis_query` handles GeoJSON conversion, spatial reference projection, pagination, and ArcGIS error semantics, and accepts either " +
  "`{ org, layer }` for cataloged layers or `{ url }` for layers returned by `find_layer`. " +
  "Start with `list_capabilities` if you're unsure what categories exist. " +
  "Fall back to `arcgis_raw` only for non-UGRC services or endpoints the curated primitives can't express.";

export class UgrcMcp extends McpAgent<Env> {
  server = new McpServer(
    {
      name: "ugrc-mcp",
      title: "Utah Geospatial Research Center",
      version: "0.2.0",
      websiteUrl: "https://gis.utah.gov",
    },
    { instructions: INSTRUCTIONS },
  );

  async init() {
    // Registration order: discovery → search → action → mapserv.
    // Some clients render the tool list in registration order; this ordering
    // reinforces the discovery-first story.
    registerGenericTools(this.server);
    registerSgidTools(this.server);
    registerHubSearchTool(this.server);
    registerArcgisTools(this.server);
    registerMapservTools(this.server, this.env);
  }
}
