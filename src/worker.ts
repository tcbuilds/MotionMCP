import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MotionApiService } from "./services/motionApi";
import { WorkspaceResolver } from "./utils/workspaceResolver";
import { InputValidator } from "./utils/validator";
import { HandlerFactory } from "./handlers/HandlerFactory";
import { ToolRegistry, ToolConfigurator } from "./tools";
import { jsonSchemaToZodShape } from "./utils/jsonSchemaToZod";
import { SERVER_INSTRUCTIONS } from "./utils/serverInstructions";

interface Env {
  MOTION_API_KEY: string;
  MOTION_MCP_SECRET: string;
  MOTION_MCP_TOOLS?: string;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface OAuthHelpers {
  parseAuthRequest(request: Request): Promise<{
    responseType: string;
    clientId: string;
    redirectUri: string;
    scope: string[];
    state: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    resource?: string | string[];
  }>;
  lookupClient(clientId: string): Promise<Record<string, unknown> | null>;
  completeAuthorization(options: {
    request: {
      responseType: string;
      clientId: string;
      redirectUri: string;
      scope: string[];
      state: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
      resource?: string | string[];
    };
    userId: string;
    metadata: Record<string, unknown>;
    scope: string[];
    props: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
}

export class MotionMCPAgent extends McpAgent<Env> {
  server = new McpServer(
    { name: "motion-mcp-server", version: "2.8.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  async init() {
    const motionService = new MotionApiService(this.env.MOTION_API_KEY);
    const workspaceResolver = new WorkspaceResolver(motionService);
    const validator = new InputValidator();
    const context = { motionService, workspaceResolver, validator };
    const handlerFactory = new HandlerFactory(context);

    const registry = new ToolRegistry();
    const configurator = new ToolConfigurator(
      this.env.MOTION_MCP_TOOLS || "complete",
      registry
    );
    const enabledTools = configurator.getEnabledTools();
    validator.initializeValidators(enabledTools);

    for (const tool of enabledTools) {
      const zodShape = jsonSchemaToZodShape(tool.inputSchema as Parameters<typeof jsonSchemaToZodShape>[0]);

      this.server.tool(
        tool.name,
        tool.description,
        zodShape,
        async (params) => {
          const handler = handlerFactory.createHandler(tool.name);
          return await handler.handle(params);
        }
      );
    }
  }
}

// Handler for OAuth-authenticated MCP API requests
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const mcpHandler = MotionMCPAgent.serve("/mcp") as {
      fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
    };
    return mcpHandler.fetch(request, env, ctx);
  },
};

// Handler for non-API routes: health check + OAuth authorize auto-approve
const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", server: "motion-mcp-server" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // OAuth authorize endpoint — auto-approve for single-user setup
    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);

  const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!clientInfo) {
    return new Response("Unknown client", { status: 400 });
  }

  // Auto-approve: single user, no consent UI needed
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "owner",
    metadata: { label: "auto-approved" },
    scope: oauthReq.scope,
    props: { userId: "owner" },
  });

  return Response.redirect(redirectTo, 302);
}

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
