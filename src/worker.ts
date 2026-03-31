import {
  OAuthProvider,
  getOAuthApi,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
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
  MOTION_MCP_TOOLS?: string;
  OAUTH_KV: KVNamespace;
}

/**
 * Build a fresh McpServer instance with all tools registered.
 * Must be called per-request because createMcpHandler requires
 * an unconnected server (stateless mode).
 */
function buildMcpServer(env: Env): McpServer {
  const motionService = new MotionApiService(env.MOTION_API_KEY);
  const workspaceResolver = new WorkspaceResolver(motionService);
  const validator = new InputValidator();
  const context = { motionService, workspaceResolver, validator };
  const handlerFactory = new HandlerFactory(context);

  const server = new McpServer(
    { name: "motion-mcp-server", version: "2.8.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const registry = new ToolRegistry();
  const configurator = new ToolConfigurator(
    env.MOTION_MCP_TOOLS || "essential",
    registry,
  );
  const enabledTools = configurator.getEnabledTools();
  // Skip Ajv schema compilation in Workers (uses new Function() which is blocked).
  // Zod validation via server.tool() handles input validation instead.

  for (const tool of enabledTools) {
    const zodShape = jsonSchemaToZodShape(
      tool.inputSchema as Parameters<typeof jsonSchemaToZodShape>[0],
    );

    server.tool(
      tool.name,
      tool.description,
      zodShape,
      async (params) => {
        const handler = handlerFactory.createHandler(tool.name);
        return await handler.handle(params);
      },
    );
  }

  return server;
}

/**
 * API handler for OAuth-protected MCP requests.
 * Creates a fresh McpServer per request to satisfy
 * createMcpHandler's stateless requirement.
 */
const mcpApiHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const server = buildMcpServer(env);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
};

/**
 * Shared OAuth provider configuration used by both
 * the OAuthProvider export and the getOAuthApi helper.
 */
function buildOAuthOptions(
  defaultHandler: OAuthProviderOptions<Env>["defaultHandler"],
): OAuthProviderOptions<Env> {
  return {
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
  };
}

/**
 * Handle OAuth authorize requests with auto-approval.
 * Logs full error details if parseAuthRequest fails so we can
 * debug redirect URI mismatches from Claude's dynamic registration.
 */
async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  const oauthHelpers = getOAuthApi(
    buildOAuthOptions(defaultHandler),
    env,
  );

  try {
    const authRequest = await oauthHelpers.parseAuthRequest(request);

    const { redirectTo } = await oauthHelpers.completeAuthorization({
      request: authRequest,
      userId: "owner",
      metadata: { label: "Motion MCP" },
      scope: authRequest.scope,
      props: { userId: "owner" },
    });

    return Response.redirect(redirectTo, 302);
  } catch (error) {
    console.error("Authorize error:", error);
    console.error("Request URL:", request.url);
    console.error(
      "Request headers:",
      Object.fromEntries(request.headers.entries()),
    );

    const url = new URL(request.url);
    return new Response(
      JSON.stringify(
        {
          error: String(error),
          url: request.url,
          params: Object.fromEntries(url.searchParams.entries()),
        },
        null,
        2,
      ),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Default handler for non-API routes.
 * Handles health checks and the OAuth authorize flow.
 * All other non-API paths return 404.
 */
const defaultHandler: OAuthProviderOptions<Env>["defaultHandler"] = {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          server: "motion-mcp-server",
          oauth: true,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider<Env>(buildOAuthOptions(defaultHandler));
