import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { analyzeRawCaptureRecords, readRawCaptureDirectory } from '../../src/plugins/request-audit/raw-cache-analyzer.js';

const rawDir = path.resolve(process.argv[2] || 'configs/request-audit-raw');
const auditDir = path.resolve(process.argv[3] || 'configs/request-audit');

async function readAuditEvents(dir) {
    if (!fs.existsSync(dir)) return [];
    const files = (await fsp.readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => path.join(dir, entry.name));
    const events = [];
    for (const file of files) {
        const content = await fsp.readFile(file, 'utf8').catch(() => '');
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch { /* ignore malformed audit rows */ }
        }
    }
    return events;
}

const records = await readRawCaptureDirectory(rawDir);
const auditEvents = await readAuditEvents(auditDir);
const report = analyzeRawCaptureRecords(records, { auditEvents });
process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    rawCaptureCount: records.length,
    comparisonCount: report.length,
    report
}, null, 2)}\n`);
