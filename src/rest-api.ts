import { join } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	createCategory,
	createFeed,
	deleteCategory,
	deleteFeed,
	getConfig,
	listCategories,
	listDigests,
	listFeeds,
	setConfig,
	updateCategory,
	updateFeed,
} from './db';
import { reloadScheduler, runJob } from './scheduler';

const NANO_API_URL =
	process.env.NANO_API_URL ?? 'http://host.docker.internal:3000';
const NANO_INTERNAL_TOKEN = process.env.NANO_INTERNAL_TOKEN;
if (!NANO_INTERNAL_TOKEN)
	throw new Error('NANO_INTERNAL_TOKEN environment variable must be set');

const DIGESTS_DIR = '/data/digests';
const FRONTEND_INDEX_PATH =
	process.env.FRONTEND_INDEX_PATH ??
	join(process.cwd(), 'src', 'frontend', 'index.html');

function nanoHeaders() {
	return {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${NANO_INTERNAL_TOKEN}`,
	};
}

export function createRestApp(): Hono {
	const app = new Hono();
	app.use('*', cors());

	// ---------------------------------------------------------------------------
	// Frontend
	// ---------------------------------------------------------------------------

	app.get('/', (_c) => {
		const html = Bun.file(FRONTEND_INDEX_PATH);
		return new Response(html, { headers: { 'Content-Type': 'text/html' } });
	});

	// ---------------------------------------------------------------------------
	// Agents proxy
	// ---------------------------------------------------------------------------

	app.get('/agents', async (c) => {
		try {
			const res = await fetch(`${NANO_API_URL}/internal/agents`, {
				headers: nanoHeaders(),
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) return c.json({ error: 'Failed to fetch agents' }, 502);
			const data = (await res.json()) as { agents: unknown[] };
			const running = (data.agents ?? []).filter(
				(a) => (a as { status: string }).status === 'running',
			);
			return c.json({ agents: running });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	// ---------------------------------------------------------------------------
	// Config
	// ---------------------------------------------------------------------------

	app.get('/config', (c) => {
		return c.json({ config: getConfig() });
	});

	app.put('/config', async (c) => {
		let body: {
			agent_id?: string;
			cron_expression?: string;
			enabled?: boolean;
			timezone?: string;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}

		setConfig(body);
		reloadScheduler();

		return c.json({ config: getConfig() });
	});

	// ---------------------------------------------------------------------------
	// Categories
	// ---------------------------------------------------------------------------

	app.get('/categories', (c) => {
		const categories = listCategories();
		return c.json({ categories });
	});

	app.post('/categories', async (c) => {
		let body: { name?: string; max_articles?: number };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}
		if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

		const maxArticles =
			typeof body.max_articles === 'number' && body.max_articles > 0
				? body.max_articles
				: 10;
		const category = createCategory(body.name.trim(), maxArticles);
		return c.json({ category }, 201);
	});

	app.put('/categories/:id', async (c) => {
		const id = c.req.param('id');
		let body: { name?: string; position?: number; max_articles?: number };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}

		const ok = updateCategory(id, body);
		if (!ok) return c.json({ error: 'Category not found' }, 404);
		return c.json({ ok: true });
	});

	app.delete('/categories/:id', (c) => {
		const ok = deleteCategory(c.req.param('id'));
		if (!ok) return c.json({ error: 'Category not found' }, 404);
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------------------
	// Feeds
	// ---------------------------------------------------------------------------

	app.get('/feeds', (c) => {
		return c.json({ feeds: listFeeds() });
	});

	app.post('/feeds', async (c) => {
		let body: { category_id?: string; url?: string; name?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}

		if (!body.category_id || !body.url?.trim() || !body.name?.trim())
			return c.json({ error: 'category_id, url and name are required' }, 400);

		const feed = createFeed(
			body.category_id,
			body.url.trim(),
			body.name.trim(),
		);
		return c.json({ feed }, 201);
	});

	app.put('/feeds/:id', async (c) => {
		const id = c.req.param('id');
		let body: { url?: string; name?: string; category_id?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}

		const ok = updateFeed(id, body);
		if (!ok) return c.json({ error: 'Feed not found' }, 404);
		return c.json({ ok: true });
	});

	app.delete('/feeds/:id', (c) => {
		const ok = deleteFeed(c.req.param('id'));
		if (!ok) return c.json({ error: 'Feed not found' }, 404);
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------------------
	// Digests
	// ---------------------------------------------------------------------------

	app.get('/digests', (c) => {
		return c.json({ digests: listDigests() });
	});

	app.get('/digests/:filename', async (c) => {
		const filename = c.req.param('filename');
		// Block path traversal
		if (filename.includes('/') || filename.includes('..')) {
			return c.json({ error: 'Invalid filename' }, 400);
		}

		const filepath = join(DIGESTS_DIR, filename);
		const file = Bun.file(filepath);

		if (!(await file.exists())) {
			return c.json({ error: 'Digest not found' }, 404);
		}

		return new Response(file, {
			headers: { 'Content-Type': 'application/pdf' },
		});
	});

	app.post('/digests/generate', async (c) => {
		// Fire-and-forget — generation can take a while
		runJob().catch((err) =>
			console.error('[news] Manual generation failed:', err),
		);
		return c.json({ ok: true, message: 'Digest generation started' });
	});

	return app;
}

export async function startRestApi(): Promise<void> {
	const app = createRestApp();
	const port = Number(process.env.REST_API_PORT ?? 8830);

	Bun.serve({ port, fetch: app.fetch });
	console.log(`[REST] Server listening on :${port}`);
}
