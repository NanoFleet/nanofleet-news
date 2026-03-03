import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
	PDFDocument,
	type PDFFont,
	type PDFPage,
	rgb,
	StandardFonts,
} from 'pdf-lib';
import Parser from 'rss-parser';
import {
	createDigest,
	getConfig,
	listCategories,
	listFeedsForCategory,
} from './db';

const DIGESTS_DIR = '/data/digests';
const MAX_DESC_LENGTH = 220;

// A4 dimensions in points
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 45;
const CONTENT_W = PAGE_W - MARGIN * 2;

interface Article {
	title: string;
	description: string;
	link: string;
}

interface CategoryBlock {
	category: string;
	articles: Article[];
}

// ---------------------------------------------------------------------------
// RSS fetching
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
	return html
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

async function fetchCategory(
	categoryName: string,
	feedUrls: string[],
	maxArticles: number,
): Promise<CategoryBlock> {
	const parser = new Parser({ timeout: 10_000 });
	const articles: Article[] = [];

	for (const url of feedUrls) {
		try {
			const feed = await parser.parseURL(url);
			const items = (feed.items ?? []).slice(0, maxArticles);

			for (const item of items) {
				const title = stripHtml(item.title ?? '').trim();
				const raw =
					item.contentSnippet ?? stripHtml(item.content ?? item.summary ?? '');
				const description = truncate(raw.trim(), MAX_DESC_LENGTH);
				const link = item.link ?? '';

				if (title) {
					articles.push({ title, description, link });
				}
			}
		} catch (err) {
			console.warn(`[news] Failed to fetch feed ${url}:`, err);
		}
	}

	return { category: categoryName, articles };
}

async function fetchCategoryViaAgent(
	categoryName: string,
	maxArticles: number,
	agentId: string,
): Promise<CategoryBlock> {
	const prompt =
		`Search the web for the ${maxArticles} most recent and relevant news articles about "${categoryName}". ` +
		`Return ONLY a valid JSON array with no other text, in this exact format:\n` +
		`[{"title": "Article title", "description": "Short description", "link": "https://..."}]`;

	try {
		const res = await fetch(
			`http://nanofleet-agent-${agentId}:4111/api/agents/main/generate`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
				signal: AbortSignal.timeout(60_000),
			},
		);

		if (!res.ok) {
			console.warn(
				`[news] Agent search failed for "${categoryName}": HTTP ${res.status}`,
			);
			return { category: categoryName, articles: [] };
		}

		const data = (await res.json()) as { text: string };
		const match = (data.text ?? '').match(/\[[\s\S]*\]/);
		if (!match) {
			console.warn(
				`[news] Could not parse agent response for "${categoryName}"`,
			);
			return { category: categoryName, articles: [] };
		}

		const raw = JSON.parse(match[0]) as Array<{
			title?: string;
			description?: string;
			link?: string;
		}>;

		const articles: Article[] = raw
			.slice(0, maxArticles)
			.filter((a) => a.title)
			.map((a) => ({
				title: stripHtml(a.title ?? '').trim(),
				description: truncate((a.description ?? '').trim(), MAX_DESC_LENGTH),
				link: a.link ?? '',
			}));

		return { category: categoryName, articles };
	} catch (err) {
		console.warn(`[news] Agent search error for "${categoryName}":`, err);
		return { category: categoryName, articles: [] };
	}
}

export async function fetchAllArticles(): Promise<CategoryBlock[]> {
	const config = getConfig();
	const categories = listCategories();
	const blocks: CategoryBlock[] = [];

	for (const cat of categories) {
		const feeds = listFeedsForCategory(cat.id);

		let block: CategoryBlock;
		if (feeds.length > 0) {
			block = await fetchCategory(
				cat.name,
				feeds.map((f) => f.url),
				cat.max_articles,
			);
		} else if (config.agent_id) {
			block = await fetchCategoryViaAgent(
				cat.name,
				cat.max_articles,
				config.agent_id,
			);
		} else {
			continue;
		}

		if (block.articles.length > 0) {
			blocks.push(block);
		}
	}

	return blocks;
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

function wrapText(
	text: string,
	font: PDFFont,
	size: number,
	maxWidth: number,
): string[] {
	const words = text.split(' ');
	const lines: string[] = [];
	let current = '';

	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
			current = candidate;
		} else {
			if (current) lines.push(current);
			// If a single word is wider than maxWidth, push it as-is
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

class PageWriter {
	private doc: PDFDocument;
	private page!: PDFPage;
	private y = 0;
	private fontRegular: PDFFont;
	private fontBold: PDFFont;

	constructor(doc: PDFDocument, fontRegular: PDFFont, fontBold: PDFFont) {
		this.doc = doc;
		this.fontRegular = fontRegular;
		this.fontBold = fontBold;
		this.newPage();
	}

	private newPage() {
		this.page = this.doc.addPage([PAGE_W, PAGE_H]);
		this.y = PAGE_H - MARGIN;
	}

	private ensureSpace(needed: number) {
		if (this.y - needed < MARGIN) {
			this.newPage();
		}
	}

	private drawText(
		text: string,
		font: PDFFont,
		size: number,
		color = rgb(0, 0, 0),
		indent = 0,
	) {
		this.page.drawText(text, {
			x: MARGIN + indent,
			y: this.y,
			size,
			font,
			color,
		});
		this.y -= size * 1.4;
	}

	private drawWrapped(
		text: string,
		font: PDFFont,
		size: number,
		color = rgb(0, 0, 0),
		indent = 0,
	) {
		const lines = wrapText(text, font, size, CONTENT_W - indent);
		for (const line of lines) {
			this.ensureSpace(size * 1.6);
			this.drawText(line, font, size, color, indent);
		}
	}

	private drawRule(color = rgb(0.7, 0.7, 0.7)) {
		this.page.drawLine({
			start: { x: MARGIN, y: this.y },
			end: { x: PAGE_W - MARGIN, y: this.y },
			thickness: 0.5,
			color,
		});
		this.y -= 8;
	}

	drawHeader(date: string) {
		// Title
		this.ensureSpace(60);
		this.drawText('NanoFleet News', this.fontBold, 28, rgb(0.1, 0.1, 0.1));
		this.y -= 4;
		this.drawText(date, this.fontRegular, 10, rgb(0.4, 0.4, 0.4));
		this.y -= 6;
		this.drawRule(rgb(0.1, 0.1, 0.1));
		this.y -= 4;
	}

	drawCategory(name: string) {
		this.ensureSpace(40);
		this.y -= 8;
		this.drawText(name.toUpperCase(), this.fontBold, 13, rgb(0.15, 0.15, 0.15));
		this.y -= 2;
		this.drawRule();
	}

	drawArticle(article: Article) {
		this.ensureSpace(50);
		this.y -= 4;

		// Title
		this.drawWrapped(article.title, this.fontBold, 10, rgb(0, 0, 0));

		// Description
		if (article.description) {
			this.drawWrapped(
				article.description,
				this.fontRegular,
				8.5,
				rgb(0.25, 0.25, 0.25),
			);
		}

		// Link
		if (article.link) {
			const shortLink =
				article.link.length > 80
					? `${article.link.slice(0, 77)}…`
					: article.link;
			this.ensureSpace(14);
			this.drawText(shortLink, this.fontRegular, 7.5, rgb(0.3, 0.3, 0.8));
		}

		this.y -= 4;
	}
}

async function buildPdf(
	blocks: CategoryBlock[],
	date: string,
): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
	const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

	const writer = new PageWriter(doc, fontRegular, fontBold);

	writer.drawHeader(date);

	for (const block of blocks) {
		writer.drawCategory(block.category);
		for (const article of block.articles) {
			writer.drawArticle(article);
		}
	}

	return doc.save();
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runDigest(): Promise<string | null> {
	await mkdir(DIGESTS_DIR, { recursive: true });

	const blocks = await fetchAllArticles();
	if (blocks.length === 0) {
		console.warn(
			'[news] No articles fetched — no feeds configured or all feeds failed. Skipping digest.',
		);
		return null;
	}

	const date = new Date().toISOString().slice(0, 10);
	const filename = `journal-${date}.pdf`;
	const filepath = join(DIGESTS_DIR, filename);

	const pdfBytes = await buildPdf(blocks, date);
	await Bun.write(filepath, pdfBytes);

	createDigest(filename);

	console.log(
		`[news] Digest generated: ${filename} (${pdfBytes.length} bytes)`,
	);

	return filename;
}
