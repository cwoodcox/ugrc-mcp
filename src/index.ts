import { UgrcMcp } from "./mcp";

export { UgrcMcp };

const streamable = UgrcMcp.serve("/mcp", { binding: "MCP_OBJECT" });
const sse = UgrcMcp.serveSSE("/sse", { binding: "MCP_OBJECT" });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return streamable.fetch(request, env, ctx);
    }
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      return sse.fetch(request, env, ctx);
    }

    return new Response(
      "UGRC GIS MCP server. /mcp = streamable HTTP, /sse = legacy SSE.",
      { status: 200, headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
