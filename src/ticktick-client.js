const axios = require('axios');
const express = require('express');
const fs = require('fs');

const TOKEN_PATH = './ticktick_token.json';

class TickTickClient {
    constructor(config) {
        this.clientId = config.ticktick.clientId;
        this.clientSecret = config.ticktick.clientSecret;
        this.redirectUri = config.ticktick.redirectUri;
        this.baseUrl = config.ticktick.baseUrl;
        this.rateLimitDelay = config.sync.rateLimitDelay;
        this.accessToken = null;
        this.tokenExpiresAt = null;
    }

    async ensureAuthenticated() {
        if (this.accessToken && !this.isTokenExpired()) return;

        const loaded = this.loadToken();
        if (loaded && !this.isTokenExpired()) return;

        console.log('No valid TickTick token found. Starting OAuth flow...');
        await this.startOAuthFlow();
    }

    isTokenExpired() {
        if (!this.tokenExpiresAt) return false;
        // Re-auth 5 minutes before actual expiry
        return Date.now() >= this.tokenExpiresAt - 5 * 60 * 1000;
    }

    loadToken() {
        try {
            if (!fs.existsSync(TOKEN_PATH)) return false;

            const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
            this.accessToken = data.access_token;
            if (data.obtained_at && data.expires_in) {
                this.tokenExpiresAt = data.obtained_at + data.expires_in * 1000;
            }
            console.log('TickTick token loaded from file');
            return true;
        } catch (error) {
            console.log('Could not load existing token:', error.message);
            return false;
        }
    }

    saveToken(tokenData) {
        const dataWithTimestamp = {
            ...tokenData,
            obtained_at: Date.now(),
        };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(dataWithTimestamp, null, 2));
        console.log('Token saved successfully');
    }

    async startOAuthFlow() {
        return new Promise((resolve, reject) => {
            const app = express();
            let server;

            app.get('/callback', async (req, res) => {
                const { code } = req.query;

                if (!code) {
                    res.send('<h1>Error: No authorization code received</h1>');
                    server.close();
                    reject(new Error('No authorization code'));
                    return;
                }

                try {
                    await this.exchangeCodeForToken(code);
                    res.send(
                        '<h1>Authorization Successful!</h1>' +
                        '<p>You can close this window and return to the terminal.</p>'
                    );
                    server.close();
                    resolve();
                } catch (error) {
                    // Don't render error.message in HTML to prevent XSS
                    res.send(
                        '<h1>Authorization Failed</h1>' +
                        '<p>Check the terminal for details.</p>'
                    );
                    console.error('OAuth error:', error.message);
                    server.close();
                    reject(error);
                }
            });

            server = app.listen(8080, () => {
                const scope = encodeURIComponent('tasks:write tasks:read');
                const redirectUri = encodeURIComponent(this.redirectUri);
                const authUrl = `https://ticktick.com/oauth/authorize?client_id=${this.clientId}&scope=${scope}&response_type=code&redirect_uri=${redirectUri}`;

                console.log('OAuth server started on http://localhost:8080');
                console.log('Please open this URL in your browser:');
                console.log(authUrl);
                console.log('\nAfter authorization, return here...');
            });

            setTimeout(() => {
                server.close();
                reject(new Error('OAuth timeout - please try again'));
            }, 300000);
        });
    }

    async exchangeCodeForToken(code) {
        const params = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: this.redirectUri,
        });

        const response = await axios.post('https://ticktick.com/oauth/token', params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
            },
        });

        this.accessToken = response.data.access_token;
        this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
        this.saveToken(response.data);

        return response.data;
    }

    authHeaders() {
        return {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
        };
    }

    async requestWithReauth(fn) {
        try {
            return await fn();
        } catch (error) {
            if (error.response?.status === 401) {
                console.log('Token expired or invalid, re-authenticating...');
                this.accessToken = null;
                this.tokenExpiresAt = null;
                // Remove stale token file so ensureAuthenticated triggers OAuth
                if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
                await this.ensureAuthenticated();
                return await fn();
            }
            throw error;
        }
    }

    async createTask(taskData) {
        await this.ensureAuthenticated();
        return this.requestWithReauth(async () => {
            const response = await axios.post(`${this.baseUrl}/task`, taskData, {
                headers: this.authHeaders(),
            });
            return response.data;
        });
    }

    async completeTask(taskId) {
        await this.ensureAuthenticated();
        await this.delay(this.rateLimitDelay);
        return this.requestWithReauth(async () => {
            const response = await axios.post(`${this.baseUrl}/task/${taskId}`, {
                status: 1,
            }, {
                headers: this.authHeaders(),
            });
            return response.data;
        });
    }

    async markTaskRemoved(taskId) {
        await this.ensureAuthenticated();
        await this.delay(this.rateLimitDelay);
        return this.requestWithReauth(async () => {
            const response = await axios.post(`${this.baseUrl}/task/${taskId}`, {
                status: 1,
                tags: ['jobsearch', 'deleted'],
            }, {
                headers: this.authHeaders(),
            });
            return response.data;
        });
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = { TickTickClient };
