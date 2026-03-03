const { loadConfig } = require('./config');
const { SyncDatabase } = require('./database');
const { DexClient } = require('./dex-client');
const { TickTickClient } = require('./ticktick-client');
const { SyncService } = require('./sync');

const config = loadConfig();

const db = new SyncDatabase(config.database.path);
const dexClient = new DexClient(config);
const ticktickClient = new TickTickClient(config);
const sync = new SyncService(db, dexClient, ticktickClient, config);

function shutdown() {
    console.log('\nShutting down...');
    sync.stop();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

sync.start().catch((error) => {
    console.error('Failed to start:', error.message);
    process.exit(1);
});
