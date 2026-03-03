require('dotenv').config();
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

class DexTickTickSync {
    constructor() {
        this.config = {
            dex: {
                apiKey: process.env.DEX_API_KEY,
                baseUrl: 'https://api.getdex.com/api/rest'
            },
            ticktick: {
                clientId: process.env.TICKTICK_CLIENT_ID,
                clientSecret: process.env.TICKTICK_CLIENT_SECRET,
                redirectUri: process.env.TICKTICK_REDIRECT_URI || 'http://localhost:8080/callback',
                baseUrl: 'https://api.ticktick.com/open/v1',
                accessToken: null
            },
            database: {
                path: process.env.DATABASE_PATH || './job_search_data.db'
            },
            sync: {
                intervalSeconds: parseInt(process.env.SYNC_INTERVAL_SECONDS) || 60,
                rateLimitDelay: parseInt(process.env.RATE_LIMIT_DELAY) || 1500
            }
        };
        
        this.db = null;
        this.isRunning = false;
    }

    async initialize() {
        console.log('🚀 Initializing Dex-TickTick Sync...');
        
        // Initialize database
        await this.initializeDatabase();
        
        // Load TickTick token if it exists
        await this.loadTickTickToken();
        
        // If no token, start OAuth flow
        if (!this.config.ticktick.accessToken) {
            console.log('🔐 No TickTick token found. Starting OAuth flow...');
            await this.startOAuthFlow();
        }
        
        console.log('✅ Initialization complete!');
        return true;
    }

    async initializeDatabase() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.config.database.path, (err) => {
                if (err) {
                    console.error('❌ Database connection failed:', err);
                    reject(err);
                    return;
                }
                console.log('📄 Connected to SQLite database');
                
                // Create tables
                this.db.serialize(() => {
                    // Main job search records table
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS job_search_records (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            dex_reminder_id TEXT UNIQUE NOT NULL,
                            ticktick_task_id TEXT,
                            notion_page_id TEXT,
                            reminder_title TEXT,
                            reminder_body TEXT,
                            due_date TEXT,
                            status TEXT DEFAULT 'active',
                            contact_id TEXT,
                            contact_name TEXT,
                            contact_email TEXT,
                            contact_phone TEXT,
                            contact_title TEXT,
                            contact_company TEXT,
                            contact_linkedin TEXT,
                            contact_full_data TEXT,
                            job_company TEXT,
                            job_title TEXT,
                            job_stage TEXT DEFAULT 'networking',
                            application_date TEXT,
                            follow_up_notes TEXT,
                            priority_level INTEGER DEFAULT 1,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            last_synced_dex DATETIME,
                            last_synced_ticktick DATETIME,
                            last_synced_notion DATETIME
                        )
                    `);
                    
                    // Activity log table
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS activity_log (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            record_id INTEGER,
                            action TEXT NOT NULL,
                            source TEXT NOT NULL,
                            details TEXT,
                            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY (record_id) REFERENCES job_search_records (id)
                        )
                    `);
                    
                    console.log('📋 Database tables ready');
                    resolve();
                });
            });
        });
    }

    async loadTickTickToken() {
        const tokenPath = './ticktick_token.json';
        try {
            if (fs.existsSync(tokenPath)) {
                const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
                this.config.ticktick.accessToken = tokenData.access_token;
                console.log('🔑 TickTick token loaded from file');
                return true;
            }
        } catch (error) {
            console.log('⚠️  Could not load existing token:', error.message);
        }
        return false;
    }

    async startOAuthFlow() {
        const express = require('express');
        const app = express();
        
        return new Promise((resolve, reject) => {
            let server;
            
            app.get('/callback', async (req, res) => {
                const { code } = req.query;
                
                if (code) {
                    try {
                        await this.exchangeCodeForToken(code);
                        res.send(`
                            <h1>✅ Authorization Successful!</h1>
                            <p>You can close this window and return to the terminal.</p>
                        `);
                        server.close();
                        resolve();
                    } catch (error) {
                        res.send(`<h1>❌ Authorization Failed</h1><p>${error.message}</p>`);
                        server.close();
                        reject(error);
                    }
                } else {
                    res.send('<h1>❌ No authorization code received</h1>');
                    server.close();
                    reject(new Error('No authorization code'));
                }
            });
            
            server = app.listen(8080, () => {
                const authUrl = `https://ticktick.com/oauth/authorize?client_id=${this.config.ticktick.clientId}&scope=tasks:write tasks:read&response_type=code&redirect_uri=${encodeURIComponent(this.config.ticktick.redirectUri)}`;
                
                console.log('🌐 OAuth server started on http://localhost:8080');
                console.log('📱 Please open this URL in your browser:');
                console.log(authUrl);
                console.log('\n💡 After authorization, return here...');
            });
            
            // Timeout after 5 minutes
            setTimeout(() => {
                server.close();
                reject(new Error('OAuth timeout - please try again'));
            }, 300000);
        });
    }

    async exchangeCodeForToken(code) {
        try {
            // TickTick expects form-encoded data, not JSON
            const params = new URLSearchParams();
            params.append('client_id', this.config.ticktick.clientId);
            params.append('client_secret', this.config.ticktick.clientSecret);
            params.append('code', code);
            params.append('grant_type', 'authorization_code');
            params.append('redirect_uri', this.config.ticktick.redirectUri);
            
            const response = await axios.post('https://ticktick.com/oauth/token', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                }
            });
            
            this.config.ticktick.accessToken = response.data.access_token;
            
            // Save token to file
            fs.writeFileSync('./ticktick_token.json', JSON.stringify(response.data, null, 2));
            console.log('💾 Token saved successfully');
            
            return response.data;
        } catch (error) {
            console.error('❌ Token exchange failed:', error.response?.data || error.message);
            throw error;
        }
    }

    async fetchDexReminders() {
        try {
            // Get all reminders with limit parameter
            const response = await axios.get(`${this.config.dex.baseUrl}/reminders?limit=100&offset=0`, {
                headers: {
                    'x-hasura-dex-api-key': this.config.dex.apiKey,
                    'Content-Type': 'application/json'
                }
            });
            
            return response.data.reminders || [];
        } catch (error) {
            console.error('❌ Failed to fetch Dex reminders:', error.message);
            return [];
        }
    }

    async fetchDexContact(contactId) {
        try {
            await this.delay(this.config.sync.rateLimitDelay);
            
            const response = await axios.get(`${this.config.dex.baseUrl}/contacts/${contactId}`, {
                headers: {
                    'x-hasura-dex-api-key': this.config.dex.apiKey,
                    'Content-Type': 'application/json'
                }
            });
            
            return response.data.contacts?.[0] || null;
        } catch (error) {
            console.error(`❌ Failed to fetch contact ${contactId}:`, error.message);
            return null;
        }
    }

    extractJobInfo(reminderText) {
        const text = reminderText.toLowerCase();
        
        // Company extraction patterns
        const companyPatterns = [
            /at\s+([A-Z][A-Za-z\s&]+?)(?:\s|$)/,
            /with\s+([A-Z][A-Za-z\s&]+?)(?:\s|$)/,
            /([A-Z][A-Za-z\s&]+?)\s+(?:job|position|role)/i
        ];
        
        let company = null;
        for (const pattern of companyPatterns) {
            const match = reminderText.match(pattern);
            if (match) {
                company = match[1].trim();
                break;
            }
        }
        
        // Position extraction
        const positionPatterns = [
            /(?:for|as)\s+([a-z\s]+(?:engineer|developer|manager|analyst|coordinator))/i,
            /(engineer|developer|manager|analyst|coordinator)/i
        ];
        
        let position = null;
        for (const pattern of positionPatterns) {
            const match = reminderText.match(pattern);
            if (match) {
                position = match[1].trim();
                break;
            }
        }
        
        return { company, position };
    }

    formatTaskContent(record, contactsData) {
        let content = ``;
        
        // Job details if extracted
        if (record.job_company || record.job_title) {
            content += `💼 **Job Details:**\n`;
            if (record.job_company) content += `• Company: ${record.job_company}\n`;
            if (record.job_title) content += `• Position: ${record.job_title}\n`;
            content += `• Stage: ${record.job_stage}\n\n`;
        }
        
        // Contact information
        contactsData.forEach((contact, index) => {
            if (contact) {
                content += `👤 **Contact${contactsData.length > 1 ? ` ${index + 1}` : ''}: ${contact.first_name} ${contact.last_name}**\n`;
                
                // Email with mailto links
                if (contact.emails && contact.emails.length > 0) {
                    content += `• Email: ${contact.emails.map(e => `[${e.email}](mailto:${e.email})`).join(', ')}\n`;
                }
                
                // Phone with tel links - FIXED VERSION
                if (contact.phones && contact.phones.length > 0) {
                    const phoneEntries = contact.phones.map(p => {
                        // Safely extract phone number
                        const phoneNumber = (p && p.phone_number) ? String(p.phone_number) : (p ? String(p) : '');
                        const label = (p && p.label) ? String(p.label) : '';
                        
                        // Only process if we have a valid phone number string
                        if (phoneNumber && phoneNumber.trim()) {
                            const cleanPhone = phoneNumber.replace(/\s+/g, '').replace(/[()]/g, '');
                            return `[${phoneNumber}](tel:${cleanPhone})${label ? ` (${label})` : ''}`;
                        } else {
                            return null; // Skip invalid entries
                        }
                    }).filter(Boolean); // Remove null entries
                    
                    if (phoneEntries.length > 0) {
                        content += `• Phone: ${phoneEntries.join(', ')}\n`;
                    }
                }
                
                if (contact.job_title) {
                    content += `• Title: ${contact.job_title}\n`;
                }
                
                // LinkedIn with proper URL formatting
                if (contact.linkedin) {
                    let linkedinUrl;
                    if (contact.linkedin.startsWith('http')) {
                        linkedinUrl = contact.linkedin;
                    } else if (contact.linkedin.includes('linkedin.com/in/')) {
                        linkedinUrl = contact.linkedin.startsWith('https://') ? contact.linkedin : `https://${contact.linkedin}`;
                    } else {
                        linkedinUrl = `https://linkedin.com/in/${contact.linkedin}`;
                    }
                    content += `• LinkedIn: [Profile](${linkedinUrl})\n`;
                }
                
                content += '\n';
            }
        });
        
        // Reminder metadata
        content += `📅 **Reminder Details:**\n`;
        content += `• Due: ${record.due_date}\n`;
        content += `• Created: ${new Date().toLocaleDateString()}\n`;
        content += `• Dex ID: ${record.dex_reminder_id}`;
        
        return content;
    }

    async createTickTickTask(record, contactsData) {
        try {
            const title = record.reminder_body;
            const content = this.formatTaskContent(record, contactsData);
            
            const taskData = {
                title: title,
                content: content,
                tags: ["jobsearch"]
            };
            
            if (record.due_date) {
                taskData.dueDate = `${record.due_date}T23:59:59.000+0000`;
            }
            
            const response = await axios.post(`${this.config.ticktick.baseUrl}/task`, taskData, {
                headers: {
                    'Authorization': `Bearer ${this.config.ticktick.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return response.data;
        } catch (error) {
            console.error('❌ Failed to create TickTick task:', error.response?.data || error.message);
            throw error;
        }
    }

    async logActivity(recordId, action, source, details) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO activity_log (record_id, action, source, details) VALUES (?, ?, ?, ?)',
                [recordId, action, source, details],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async processNewReminders() {
        console.log('🔍 Checking for new Dex reminders...');
        
        const reminders = await this.fetchDexReminders();
        console.log(`📋 Found ${reminders.length} total reminders in Dex`);
        
        // Check for removed reminders first
        await this.processRemovedReminders(reminders);
        
        for (const reminder of reminders) {
            // Check if reminder was completed in Dex
            await this.processCompletedReminder(reminder);
            
            // Skip if already complete - no need to create new task
            if (reminder.is_complete) continue;
            
            // Check if we've already processed this reminder
            const existing = await this.getExistingRecord(reminder.id);
            if (existing) continue;
            
            console.log(`📝 Processing new reminder: ${reminder.body}`);
            
            // Extract job information
            const jobInfo = this.extractJobInfo(reminder.body);
            
            // Fetch contact details
            const contactsData = [];
            if (reminder.contact_ids && reminder.contact_ids.length > 0) {
                for (const contactRef of reminder.contact_ids) {
                    const contact = await this.fetchDexContact(contactRef.contact_id);
                    contactsData.push(contact);
                }
            }
            
            // Create record
            const record = {
                dex_reminder_id: reminder.id,
                reminder_title: reminder.body.substring(0, 100),
                reminder_body: reminder.body,
                due_date: reminder.due_at_date,
                contact_id: reminder.contact_ids?.[0]?.contact_id || null,
                contact_name: contactsData[0] ? `${contactsData[0].first_name} ${contactsData[0].last_name}` : null,
                contact_email: contactsData[0]?.emails?.[0]?.email || null,
                contact_phone: contactsData[0]?.phones?.[0]?.phone_number || null,
                contact_full_data: JSON.stringify(contactsData),
                job_company: jobInfo.company,
                job_title: jobInfo.position
            };
            
            try {
                // Create TickTick task
                const ticktickTask = await this.createTickTickTask(record, contactsData);
                record.ticktick_task_id = ticktickTask.id;
                
                // Save to database
                const recordId = await this.saveRecord(record);
                await this.logActivity(recordId, 'created', 'dex', `Synced reminder to TickTick: ${ticktickTask.id}`);
                
                console.log(`✅ Created TickTick task: ${record.reminder_body}`);
                
                await this.delay(this.config.sync.rateLimitDelay);
                
            } catch (error) {
                console.error(`❌ Failed to process reminder ${reminder.id}:`, error.message);
            }
        }
    }

    async getExistingRecord(dexReminderId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM job_search_records WHERE dex_reminder_id = ?',
                [dexReminderId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async saveRecord(record) {
        return new Promise((resolve, reject) => {
            const fields = Object.keys(record).join(', ');
            const placeholders = Object.keys(record).map(() => '?').join(', ');
            const values = Object.values(record);
            
            this.db.run(
                `INSERT INTO job_search_records (${fields}) VALUES (${placeholders})`,
                values,
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async processCompletedReminder(reminder) {
        // Only check reminders that are marked complete in Dex
        if (!reminder.is_complete) return;
        
        // Check if we have a record for this reminder
        const existingRecord = await this.getExistingRecord(reminder.id);
        if (!existingRecord) return;
        
        // Check if we've already processed this completion
        if (existingRecord.status === 'completed') return;
        
        // Check if we have a TickTick task ID to complete
        if (!existingRecord.ticktick_task_id) {
            console.log(`⚠️  No TickTick task found for completed reminder: ${reminder.body}`);
            return;
        }
        
        try {
            console.log(`✅ Dex reminder completed, syncing to TickTick: ${reminder.body}`);
            
            // Complete the TickTick task
            await this.completeTickTickTask(existingRecord.ticktick_task_id);
            
            // Update our database record
            await this.updateRecordStatus(existingRecord.id, 'completed');
            await this.logActivity(existingRecord.id, 'completed', 'dex', `Marked TickTick task complete: ${existingRecord.ticktick_task_id}`);
            
            console.log(`🎉 Completed TickTick task for: ${reminder.body}`);
            
        } catch (error) {
            console.error(`❌ Failed to complete TickTick task for reminder ${reminder.id}:`, error.message);
        }
    }

    async completeTickTickTask(taskId) {
        try {
            await this.delay(this.config.sync.rateLimitDelay);
            
            // Complete the task normally (no tag changes for regular completion)
            const response = await axios.post(`${this.config.ticktick.baseUrl}/task/${taskId}`, {
                status: 1
            }, {
                headers: {
                    'Authorization': `Bearer ${this.config.ticktick.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return response.data;
        } catch (error) {
            console.error('❌ Failed to complete TickTick task:', error.response?.data || error.message);
            throw error;
        }
    }

    async processRemovedReminders(currentReminders) {
        // Get all active records from our database
        const activeRecords = await this.getActiveRecords();
        
        // Create a set of current reminder IDs for fast lookup
        const currentReminderIds = new Set(currentReminders.map(r => r.id));
        
        // Find records that no longer exist in Dex
        const removedRecords = activeRecords.filter(record => 
            !currentReminderIds.has(record.dex_reminder_id)
        );
        
        if (removedRecords.length === 0) return;
        
        console.log(`🗑️  Found ${removedRecords.length} removed reminder(s) in Dex`);
        
        for (const record of removedRecords) {
            try {
                console.log(`🗑️  Processing removed reminder: ${record.reminder_body}`);
                
                // Complete the TickTick task and add #deleted tag if it exists
                if (record.ticktick_task_id) {
                    await this.markTaskAsRemoved(record.ticktick_task_id);
                }
                
                // Update our database record
                await this.updateRecordStatus(record.id, 'removed');
                await this.logActivity(record.id, 'removed', 'dex', `Marked TickTick task complete with #deleted tag: ${record.ticktick_task_id}`);
                
                console.log(`✅ Marked removed Dex reminder as complete with #deleted tag: ${record.reminder_body}`);
                
                await this.delay(this.config.sync.rateLimitDelay);
                
            } catch (error) {
                console.error(`❌ Failed to mark TickTick task for record ${record.id}:`, error.message);
            }
        }
    }

    async getActiveRecords() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM job_search_records WHERE (status = ? OR status IS NULL) AND ticktick_task_id IS NOT NULL',
                ['active'],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async markTaskAsRemoved(taskId) {
        try {
            await this.delay(this.config.sync.rateLimitDelay);
            
            // Complete the task and add #deleted tag
            const response = await axios.post(`${this.config.ticktick.baseUrl}/task/${taskId}`, {
                status: 1,
                tags: ["jobsearch", "deleted"]
            }, {
                headers: {
                    'Authorization': `Bearer ${this.config.ticktick.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return response.data;
        } catch (error) {
            console.error('❌ Failed to mark TickTick task as removed:', error.response?.data || error.message);
            throw error;
        }
    }

    async updateRecordStatus(recordId, status) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE job_search_records SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [status, recordId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        try {
            await this.initialize();
            
            console.log(`🔄 Starting sync loop (every ${this.config.sync.intervalSeconds} seconds)`);
            this.isRunning = true;
            
            // Initial sync
            await this.processNewReminders();
            
            // Set up recurring sync
            const syncInterval = setInterval(async () => {
                if (!this.isRunning) {
                    clearInterval(syncInterval);
                    return;
                }
                
                try {
                    await this.processNewReminders();
                } catch (error) {
                    console.error('❌ Sync loop error:', error.message);
                }
            }, this.config.sync.intervalSeconds * 1000);
            
            console.log('🎉 Dex-TickTick sync is running! Press Ctrl+C to stop.');
            
        } catch (error) {
            console.error('❌ Failed to start sync:', error.message);
            process.exit(1);
        }
    }

    stop() {
        this.isRunning = false;
        if (this.db) {
            this.db.close();
        }
        console.log('🛑 Sync stopped');
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Received shutdown signal...');
    process.exit(0);
});

// Start the sync service
const sync = new DexTickTickSync();
sync.start().catch(console.error);