import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Cause, Effect, Exit, Option } from 'effect';
import { createMcpServer, toolFailureMessage, type ToolRunner } from '$lib/server/mcp/server';
import { appRuntime } from '$lib/server/runtime';

function methodNotAllowed(): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    },
    { status: 405 },
  );
}

/**
 * Runs tool programs on the application runtime, stopped when the request is abandoned. A typed
 * failure becomes the tool's error message; anything unexpected is logged and reported generically.
 */
function toolRunner(request: Request): ToolRunner {
  return async (program) => {
    const exit = await appRuntime.runPromiseExit(
      program.pipe(
        Effect.tapCause((cause) =>
          Cause.hasDies(cause) ? Effect.logError('Unexpected failure in an MCP tool', cause) : Effect.void,
        ),
        Effect.annotateLogs({ path: '/mcp' }),
      ),
      { signal: request.signal },
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.findErrorOption(exit.cause);
    throw new Error(Option.isSome(failure) ? toolFailureMessage(failure.value) : 'Something went wrong.');
  };
}

export async function POST({ request }: { request: Request }): Promise<Response> {
  const server = createMcpServer(toolRunner(request));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
