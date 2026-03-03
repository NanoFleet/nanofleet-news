import { startMcpServer } from './mcp-server';
import { startRestApi } from './rest-api';
import { startScheduler } from './scheduler';

console.log('[nanofleet-news] Starting...');

await Promise.all([startMcpServer(), startRestApi()]);

startScheduler();

console.log('[nanofleet-news] Ready');
