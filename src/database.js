const Database = require('better-sqlite3');

class SyncDatabase {
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.initialize();
    }

    initialize() {
        this.db.exec(`
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

        this.db.exec(`
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

        this.stmts = {
            getRecord: this.db.prepare(
                'SELECT * FROM job_search_records WHERE dex_reminder_id = ?'
            ),
            getActiveRecords: this.db.prepare(
                'SELECT * FROM job_search_records WHERE (status = ? OR status IS NULL) AND ticktick_task_id IS NOT NULL'
            ),
            updateStatus: this.db.prepare(
                'UPDATE job_search_records SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ),
            logActivity: this.db.prepare(
                'INSERT INTO activity_log (record_id, action, source, details) VALUES (?, ?, ?, ?)'
            ),
        };
    }

    getRecord(dexReminderId) {
        return this.stmts.getRecord.get(dexReminderId);
    }

    getActiveRecords() {
        return this.stmts.getActiveRecords.all('active');
    }

    saveRecord(record) {
        const fields = Object.keys(record).join(', ');
        const placeholders = Object.keys(record).map(() => '?').join(', ');
        const stmt = this.db.prepare(
            `INSERT INTO job_search_records (${fields}) VALUES (${placeholders})`
        );
        const result = stmt.run(...Object.values(record));
        return result.lastInsertRowid;
    }

    updateStatus(recordId, status) {
        return this.stmts.updateStatus.run(status, recordId);
    }

    logActivity(recordId, action, source, details) {
        return this.stmts.logActivity.run(recordId, action, source, details);
    }

    close() {
        this.db.close();
    }
}

module.exports = { SyncDatabase };
