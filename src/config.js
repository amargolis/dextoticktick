require('dotenv').config();

function loadConfig() {
    const required = {
        DEX_API_KEY: process.env.DEX_API_KEY,
        TICKTICK_CLIENT_ID: process.env.TICKTICK_CLIENT_ID,
        TICKTICK_CLIENT_SECRET: process.env.TICKTICK_CLIENT_SECRET,
    };

    const missing = Object.entries(required)
        .filter(([, value]) => !value)
        .map(([key]) => key);

    if (missing.length > 0) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        console.error('Copy .env.example to .env and fill in your credentials.');
        process.exit(1);
    }

    return {
        dex: {
            apiKey: required.DEX_API_KEY,
            baseUrl: 'https://api.getdex.com/api/rest',
        },
        ticktick: {
            clientId: required.TICKTICK_CLIENT_ID,
            clientSecret: required.TICKTICK_CLIENT_SECRET,
            redirectUri: process.env.TICKTICK_REDIRECT_URI || 'http://localhost:8080/callback',
            baseUrl: 'https://api.ticktick.com/open/v1',
        },
        database: {
            path: process.env.DATABASE_PATH || './job_search_data.db',
        },
        sync: {
            intervalSeconds: parseInt(process.env.SYNC_INTERVAL_SECONDS) || 60,
            rateLimitDelay: parseInt(process.env.RATE_LIMIT_DELAY) || 1500,
        },
    };
}

module.exports = { loadConfig };
