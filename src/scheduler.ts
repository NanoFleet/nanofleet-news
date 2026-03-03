import cron from 'node-cron';
import { getConfig } from './db';
import { runDigest } from './generator';

const PLUGIN_CONTAINER = 'nanofleet-plugin-nanofleet-news';
const UI_PORT = 8830;

let currentTask: cron.ScheduledTask | null = null;

async function deliver(filename: string, agentId: string): Promise<void> {
	const url = `http://${PLUGIN_CONTAINER}:${UI_PORT}/digests/${filename}`;
	const payload = JSON.stringify({ type: 'document', url, filename });

	try {
		const res = await fetch(
			`http://nanofleet-agent-${agentId}:4111/api/agents/main/notify`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: payload, source: 'nanofleet-news' }),
				signal: AbortSignal.timeout(10_000),
			},
		);

		if (!res.ok) {
			console.warn(`[news] Notify failed: HTTP ${res.status}`);
		} else {
			console.log(`[news] Digest delivered to agent ${agentId}`);
		}
	} catch (err) {
		console.warn(`[news] Failed to notify agent ${agentId}:`, err);
	}
}

async function runJob(): Promise<void> {
	const config = getConfig();

	if (!config.agent_id) {
		console.warn(
			'[news] Scheduler triggered but no agent_id configured — skipping.',
		);
		return;
	}

	console.log('[news] Generating digest...');

	try {
		const filename = await runDigest();
		if (filename) {
			await deliver(filename, config.agent_id);
		}
	} catch (err) {
		console.error('[news] Digest generation failed:', err);
	}
}

export function startScheduler(): void {
	reloadScheduler();
}

export function reloadScheduler(): void {
	if (currentTask) {
		currentTask.stop();
		currentTask = null;
	}

	const config = getConfig();

	if (!config.enabled) {
		console.log('[news] Scheduler disabled.');
		return;
	}

	if (!cron.validate(config.cron_expression)) {
		console.warn(
			`[news] Invalid cron expression: "${config.cron_expression}" — scheduler not started.`,
		);
		return;
	}

	currentTask = cron.schedule(config.cron_expression, runJob, {
		timezone: config.timezone,
	});

	console.log(
		`[news] Scheduler started — cron: "${config.cron_expression}", timezone: ${config.timezone}`,
	);
}

export { runJob };
