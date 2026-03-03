import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

const DB_PATH = '/data/nanofleet-news.db';

let db: Database;

export function getDb(): Database {
	if (!db) {
		db = new Database(DB_PATH);
		db.exec('PRAGMA journal_mode=WAL;');
		db.exec('PRAGMA foreign_keys=ON;');
		initSchema();
	}
	return db;
}

function initSchema() {
	db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    DROP TABLE IF EXISTS feeds;
    DROP TABLE IF EXISTS categories;

    CREATE TABLE categories (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      position     INTEGER NOT NULL DEFAULT 0,
      max_articles INTEGER NOT NULL DEFAULT 10
    );

    CREATE TABLE feeds (
      id          TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      url         TEXT NOT NULL,
      name        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS digests (
      id           TEXT PRIMARY KEY,
      filename     TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Config {
	agent_id: string;
	cron_expression: string;
	enabled: boolean;
	timezone: string;
}

const CONFIG_DEFAULTS: Config = {
	agent_id: '',
	cron_expression: '0 7 * * *',
	enabled: false,
	timezone: 'UTC',
};

export function getConfig(): Config {
	const rows = getDb().query('SELECT key, value FROM config').all() as {
		key: string;
		value: string;
	}[];

	const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

	return {
		agent_id: map.agent_id ?? CONFIG_DEFAULTS.agent_id,
		cron_expression: map.cron_expression ?? CONFIG_DEFAULTS.cron_expression,
		enabled: map.enabled === 'true',
		timezone: map.timezone ?? CONFIG_DEFAULTS.timezone,
	};
}

export function setConfig(patch: Partial<Config>): void {
	const stmt = getDb().prepare(
		'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
	);

	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) {
			stmt.run(key, String(value));
		}
	}
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface CategoryRow {
	id: string;
	name: string;
	position: number;
	max_articles: number;
}

export function listCategories(): CategoryRow[] {
	return getDb()
		.query('SELECT * FROM categories ORDER BY position ASC, name ASC')
		.all() as CategoryRow[];
}

export function createCategory(name: string, maxArticles = 10): CategoryRow {
	const id = randomUUID();
	const position = (
		getDb()
			.query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM categories')
			.get() as { next: number }
	).next;

	getDb().run(
		'INSERT INTO categories (id, name, position, max_articles) VALUES (?, ?, ?, ?)',
		[id, name, position, maxArticles],
	);

	return { id, name, position, max_articles: maxArticles };
}

export function updateCategory(
	id: string,
	patch: { name?: string; position?: number; max_articles?: number },
): boolean {
	const fields: string[] = [];
	const values: unknown[] = [];

	if (patch.name !== undefined) {
		fields.push('name = ?');
		values.push(patch.name);
	}
	if (patch.position !== undefined) {
		fields.push('position = ?');
		values.push(patch.position);
	}
	if (patch.max_articles !== undefined) {
		fields.push('max_articles = ?');
		values.push(patch.max_articles);
	}
	if (fields.length === 0) return false;

	values.push(id);
	const result = getDb().run(
		`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`,
		values,
	);
	return result.changes > 0;
}

export function deleteCategory(id: string): boolean {
	const result = getDb().run('DELETE FROM categories WHERE id = ?', [id]);
	return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export interface FeedRow {
	id: string;
	category_id: string;
	url: string;
	name: string;
}

export function listFeeds(): FeedRow[] {
	return getDb()
		.query('SELECT * FROM feeds ORDER BY name ASC')
		.all() as FeedRow[];
}

export function listFeedsForCategory(categoryId: string): FeedRow[] {
	return getDb()
		.query('SELECT * FROM feeds WHERE category_id = ? ORDER BY name ASC')
		.all(categoryId) as FeedRow[];
}

export function createFeed(
	categoryId: string,
	url: string,
	name: string,
): FeedRow {
	const id = randomUUID();
	getDb().run(
		'INSERT INTO feeds (id, category_id, url, name) VALUES (?, ?, ?, ?)',
		[id, categoryId, url, name],
	);
	return { id, category_id: categoryId, url, name };
}

export function updateFeed(
	id: string,
	patch: { url?: string; name?: string; category_id?: string },
): boolean {
	const fields: string[] = [];
	const values: unknown[] = [];

	if (patch.url !== undefined) {
		fields.push('url = ?');
		values.push(patch.url);
	}
	if (patch.name !== undefined) {
		fields.push('name = ?');
		values.push(patch.name);
	}
	if (patch.category_id !== undefined) {
		fields.push('category_id = ?');
		values.push(patch.category_id);
	}
	if (fields.length === 0) return false;

	values.push(id);
	const result = getDb().run(
		`UPDATE feeds SET ${fields.join(', ')} WHERE id = ?`,
		values,
	);
	return result.changes > 0;
}

export function deleteFeed(id: string): boolean {
	const result = getDb().run('DELETE FROM feeds WHERE id = ?', [id]);
	return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export interface DigestRow {
	id: string;
	filename: string;
	generated_at: number;
}

export function listDigests(): DigestRow[] {
	return getDb()
		.query('SELECT * FROM digests ORDER BY generated_at DESC')
		.all() as DigestRow[];
}

export function createDigest(filename: string): DigestRow {
	const id = randomUUID();
	const generated_at = Date.now();
	getDb().run(
		'INSERT INTO digests (id, filename, generated_at) VALUES (?, ?, ?)',
		[id, filename, generated_at],
	);
	return { id, filename, generated_at };
}
