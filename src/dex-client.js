const axios = require('axios');

class DexClient {
    constructor(config) {
        this.apiKey = config.dex.apiKey;
        this.baseUrl = config.dex.baseUrl;
        this.rateLimitDelay = config.sync.rateLimitDelay;
    }

    async fetchReminders() {
        const allReminders = [];
        let offset = 0;
        const limit = 100;

        while (true) {
            const response = await axios.get(`${this.baseUrl}/reminders`, {
                params: { limit, offset },
                headers: {
                    'x-hasura-dex-api-key': this.apiKey,
                    'Content-Type': 'application/json',
                },
            });

            const reminders = response.data.reminders || [];
            allReminders.push(...reminders);

            if (reminders.length < limit) break;
            offset += limit;
            await this.delay(this.rateLimitDelay);
        }

        return allReminders;
    }

    async fetchContact(contactId) {
        await this.delay(this.rateLimitDelay);

        const response = await axios.get(`${this.baseUrl}/contacts/${contactId}`, {
            headers: {
                'x-hasura-dex-api-key': this.apiKey,
                'Content-Type': 'application/json',
            },
        });

        return response.data.contacts?.[0] || null;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = { DexClient };
