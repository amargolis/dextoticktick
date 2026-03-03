class SyncService {
    constructor(db, dexClient, ticktickClient, config) {
        this.db = db;
        this.dex = dexClient;
        this.ticktick = ticktickClient;
        this.rateLimitDelay = config.sync.rateLimitDelay;
        this.intervalSeconds = config.sync.intervalSeconds;
        this.isRunning = false;
    }

    async start() {
        await this.ticktick.ensureAuthenticated();
        this.isRunning = true;
        console.log(`Starting sync loop (every ${this.intervalSeconds} seconds)`);

        while (this.isRunning) {
            try {
                await this.processReminders();
            } catch (error) {
                console.error('Sync error:', error.message);
            }

            if (!this.isRunning) break;
            await this.delay(this.intervalSeconds * 1000);
        }
    }

    stop() {
        this.isRunning = false;
        this.db.close();
        console.log('Sync stopped');
    }

    async processReminders() {
        console.log('Checking for new Dex reminders...');

        const reminders = await this.dex.fetchReminders();
        console.log(`Found ${reminders.length} total reminders in Dex`);

        await this.processRemovedReminders(reminders);

        for (const reminder of reminders) {
            await this.processCompletedReminder(reminder);

            if (reminder.is_complete) continue;

            const existing = this.db.getRecord(reminder.id);
            if (existing) continue;

            console.log(`Processing new reminder: ${reminder.body}`);

            const jobInfo = extractJobInfo(reminder.body);

            const contactsData = [];
            if (reminder.contact_ids?.length > 0) {
                for (const ref of reminder.contact_ids) {
                    try {
                        const contact = await this.dex.fetchContact(ref.contact_id);
                        contactsData.push(contact);
                    } catch (error) {
                        console.error(`Failed to fetch contact ${ref.contact_id}:`, error.message);
                    }
                }
            }

            const record = {
                dex_reminder_id: reminder.id,
                reminder_title: reminder.body.substring(0, 100),
                reminder_body: reminder.body,
                due_date: reminder.due_at_date,
                contact_id: reminder.contact_ids?.[0]?.contact_id || null,
                contact_name: contactsData[0]
                    ? `${contactsData[0].first_name} ${contactsData[0].last_name}`
                    : null,
                contact_email: contactsData[0]?.emails?.[0]?.email || null,
                contact_phone: contactsData[0]?.phones?.[0]?.phone_number || null,
                contact_full_data: JSON.stringify(contactsData),
                job_company: jobInfo.company,
                job_title: jobInfo.position,
            };

            try {
                const taskData = buildTaskData(record, contactsData);
                const ticktickTask = await this.ticktick.createTask(taskData);
                record.ticktick_task_id = ticktickTask.id;

                const recordId = this.db.saveRecord(record);
                this.db.logActivity(
                    recordId, 'created', 'dex',
                    `Synced reminder to TickTick: ${ticktickTask.id}`
                );

                console.log(`Created TickTick task: ${record.reminder_body}`);
                await this.delay(this.rateLimitDelay);
            } catch (error) {
                console.error(`Failed to process reminder ${reminder.id}:`, error.message);
            }
        }
    }

    async processCompletedReminder(reminder) {
        if (!reminder.is_complete) return;

        const record = this.db.getRecord(reminder.id);
        if (!record || record.status === 'completed' || !record.ticktick_task_id) return;

        try {
            console.log(`Dex reminder completed, syncing to TickTick: ${reminder.body}`);
            await this.ticktick.completeTask(record.ticktick_task_id);
            this.db.updateStatus(record.id, 'completed');
            this.db.logActivity(
                record.id, 'completed', 'dex',
                `Marked TickTick task complete: ${record.ticktick_task_id}`
            );
            console.log(`Completed TickTick task for: ${reminder.body}`);
        } catch (error) {
            console.error(`Failed to complete TickTick task for reminder ${reminder.id}:`, error.message);
        }
    }

    async processRemovedReminders(currentReminders) {
        const activeRecords = this.db.getActiveRecords();
        const currentIds = new Set(currentReminders.map(r => r.id));
        const removed = activeRecords.filter(r => !currentIds.has(r.dex_reminder_id));

        if (removed.length === 0) return;
        console.log(`Found ${removed.length} removed reminder(s) in Dex`);

        for (const record of removed) {
            try {
                if (record.ticktick_task_id) {
                    await this.ticktick.markTaskRemoved(record.ticktick_task_id);
                }
                this.db.updateStatus(record.id, 'removed');
                this.db.logActivity(
                    record.id, 'removed', 'dex',
                    `Marked TickTick task complete with #deleted tag: ${record.ticktick_task_id}`
                );
                console.log(`Marked removed: ${record.reminder_body}`);
                await this.delay(this.rateLimitDelay);
            } catch (error) {
                console.error(`Failed to process removed record ${record.id}:`, error.message);
            }
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

function extractJobInfo(text) {
    const companyPatterns = [
        /at\s+([A-Z][A-Za-z\s&]+?)(?:\s|$)/,
        /with\s+([A-Z][A-Za-z\s&]+?)(?:\s|$)/,
        /([A-Z][A-Za-z\s&]+?)\s+(?:job|position|role)/i,
    ];

    let company = null;
    for (const pattern of companyPatterns) {
        const match = text.match(pattern);
        if (match) {
            company = match[1].trim();
            break;
        }
    }

    const positionPatterns = [
        /(?:for|as)\s+([a-z\s]+(?:engineer|developer|manager|analyst|coordinator))/i,
        /(engineer|developer|manager|analyst|coordinator)/i,
    ];

    let position = null;
    for (const pattern of positionPatterns) {
        const match = text.match(pattern);
        if (match) {
            position = match[1].trim();
            break;
        }
    }

    return { company, position };
}

function buildTaskData(record, contactsData) {
    let content = '';

    if (record.job_company || record.job_title) {
        content += '**Job Details:**\n';
        if (record.job_company) content += `- Company: ${record.job_company}\n`;
        if (record.job_title) content += `- Position: ${record.job_title}\n`;
        content += `- Stage: ${record.job_stage || 'networking'}\n\n`;
    }

    contactsData.forEach((contact, index) => {
        if (!contact) return;

        const label = contactsData.length > 1 ? ` ${index + 1}` : '';
        content += `**Contact${label}: ${contact.first_name} ${contact.last_name}**\n`;

        if (contact.emails?.length > 0) {
            content += `- Email: ${contact.emails.map(e => e.email).join(', ')}\n`;
        }

        if (contact.phones?.length > 0) {
            const phones = contact.phones
                .map(p => {
                    const number = p?.phone_number ? String(p.phone_number) : '';
                    const phoneLabel = p?.label ? String(p.label) : '';
                    return number.trim()
                        ? `${number}${phoneLabel ? ` (${phoneLabel})` : ''}`
                        : null;
                })
                .filter(Boolean);
            if (phones.length > 0) {
                content += `- Phone: ${phones.join(', ')}\n`;
            }
        }

        if (contact.job_title) content += `- Title: ${contact.job_title}\n`;

        if (contact.linkedin) {
            let url = contact.linkedin;
            if (!url.startsWith('http')) {
                url = url.includes('linkedin.com')
                    ? `https://${url}`
                    : `https://linkedin.com/in/${url}`;
            }
            content += `- LinkedIn: ${url}\n`;
        }

        content += '\n';
    });

    content += '**Reminder Details:**\n';
    content += `- Due: ${record.due_date}\n`;
    content += `- Created: ${new Date().toLocaleDateString()}\n`;
    content += `- Dex ID: ${record.dex_reminder_id}`;

    const taskData = {
        title: record.reminder_body,
        content,
        tags: ['jobsearch'],
    };

    if (record.due_date) {
        taskData.dueDate = `${record.due_date}T23:59:59.000+0000`;
    }

    return taskData;
}

module.exports = { SyncService };
