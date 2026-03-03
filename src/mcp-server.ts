import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { listDigests } from './db';
import { runJob } from './scheduler';

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
	const server = new McpServer({
		name: 'nanofleet-news',
		version: '0.0.1',
	});

	// --- tool: generate_digest ---
	server.tool(
		'generate_digest',
		'Manually trigger the generation of the news digest and deliver it to the configured channel. Use this when the user asks to generate or send the journal now.',
		{},
		async () => {
			try {
				await runJob();
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								ok: true,
								message: 'Digest generated and delivered.',
							}),
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({ error: String(err) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	// --- tool: list_digests ---
	server.tool(
		'list_digests',
		'List previously generated news digests with their date and filename.',
		{},
		async () => {
			const digests = listDigests();
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({ digests }),
					},
				],
			};
		},
	);

	return server;
}

// ---------------------------------------------------------------------------
// Start MCP HTTP server on port 8831
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
	const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

	Bun.serve({
		port: 8831,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname !== '/mcp') {
				return new Response('Not found', { status: 404 });
			}

			const sessionId = req.headers.get('mcp-session-id');

			if (req.method === 'DELETE' && sessionId) {
				sessions.delete(sessionId);
				return new Response(null, { status: 204 });
			}

			if (sessionId && sessions.has(sessionId)) {
				const transport = sessions.get(sessionId);
				if (transport) {
					return transport.handleRequest(req);
				}
			}

			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => crypto.randomUUID(),
				enableJsonResponse: true,
				onsessioninitialized: (sid) => {
					sessions.set(sid, transport);
				},
			});

			transport.onclose = () => {
				if (transport.sessionId) sessions.delete(transport.sessionId);
			};

			const server = createMcpServer();
			await server.connect(transport);

			return transport.handleRequest(req);
		},
	});

	console.log('[MCP] Server listening on :8831');
}
