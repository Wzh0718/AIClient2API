import net from 'net';
import tls from 'tls';
import { createHash } from 'crypto';

function encodeCommand(parts) {
    const values = parts.map(part => Buffer.from(String(part)));
    const chunks = [Buffer.from(`*${values.length}\r\n`)];
    for (const value of values) chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
    return Buffer.concat(chunks);
}

function readLine(buffer, offset) {
    const end = buffer.indexOf('\r\n', offset);
    if (end < 0) return null;
    return { value: buffer.toString('utf8', offset, end), next: end + 2 };
}

function parseResp(buffer, offset = 0) {
    if (offset >= buffer.length) return null;
    const prefix = String.fromCharCode(buffer[offset]);
    const line = readLine(buffer, offset + 1);
    if (!line) return null;
    if (prefix === '+') return { value: line.value, next: line.next };
    if (prefix === '-') {
        const error = new Error(line.value);
        error.redis = true;
        return { error, next: line.next };
    }
    if (prefix === ':') return { value: Number(line.value), next: line.next };
    if (prefix === '$') {
        const length = Number(line.value);
        if (length === -1) return { value: null, next: line.next };
        const end = line.next + length;
        if (buffer.length < end + 2) return null;
        return { value: buffer.toString('utf8', line.next, end), next: end + 2 };
    }
    if (prefix === '*') {
        const length = Number(line.value);
        if (length === -1) return { value: null, next: line.next };
        const values = [];
        let next = line.next;
        for (let index = 0; index < length; index++) {
            const parsed = parseResp(buffer, next);
            if (!parsed) return null;
            if (parsed.error) throw parsed.error;
            values.push(parsed.value);
            next = parsed.next;
        }
        return { value: values, next };
    }
    throw new Error(`Unsupported Redis response prefix: ${prefix}`);
}

export class RedisRespClient {
    constructor(options = {}) {
        this.host = options.host || '127.0.0.1';
        this.port = Number(options.port || 6379);
        this.password = options.password || null;
        this.database = Number(options.database || 0);
        this.useTls = options.tls === true;
        this.connectTimeoutMs = Number(options.connectTimeoutMs || 2000);
        this.commandTimeoutMs = Number(options.commandTimeoutMs || 5000);
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.pending = [];
        this.connecting = null;
        this.scriptHashes = new Map();
    }

    async connect() {
        if (this.socket && !this.socket.destroyed) return;
        if (this.connecting) return this.connecting;
        this.connecting = new Promise((resolve, reject) => {
            const socket = this.useTls
                ? tls.connect({ host: this.host, port: this.port })
                : net.createConnection({ host: this.host, port: this.port });
            let settled = false;
            const rejectConnection = error => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (this.socket === socket) this.socket = null;
                reject(error);
            };
            const timeout = setTimeout(() => {
                const error = new Error('Redis connection timeout');
                rejectConnection(error);
                socket.destroy(error);
            }, this.connectTimeoutMs);
            socket.setNoDelay(true);
            socket.on('data', chunk => this._onData(chunk));
            socket.on('error', error => {
                this._failPending(error);
                rejectConnection(error);
            });
            socket.on('close', () => {
                if (this.socket === socket) this.socket = null;
                rejectConnection(new Error('Redis connection closed before ready'));
            });
            socket.once(this.useTls ? 'secureConnect' : 'connect', async () => {
                clearTimeout(timeout);
                this.socket = socket;
                try {
                    if (this.password) await this.command(['AUTH', this.password], { skipConnect: true });
                    if (this.database) await this.command(['SELECT', this.database], { skipConnect: true });
                    settled = true;
                    resolve();
                } catch (error) {
                    rejectConnection(error);
                    socket.destroy();
                }
            });
        }).finally(() => { this.connecting = null; });
        return this.connecting;
    }

    _onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.pending.length > 0) {
            let parsed;
            try { parsed = parseResp(this.buffer); } catch (error) {
                const pending = this.pending.shift();
                pending.reject(error);
                this.buffer = Buffer.alloc(0);
                continue;
            }
            if (!parsed) break;
            this.buffer = this.buffer.subarray(parsed.next);
            const pending = this.pending.shift();
            if (parsed.error) pending.reject(parsed.error);
            else pending.resolve(parsed.value);
        }
    }

    _failPending(error) {
        while (this.pending.length) this.pending.shift().reject(error);
    }

    async command(parts, options = {}) {
        if (!options.skipConnect) await this.connect();
        if (!this.socket || this.socket.destroyed) throw new Error('Redis socket is unavailable');
        return new Promise((resolve, reject) => {
            const timeoutMs = Math.max(1, Number(options.timeoutMs ?? this.commandTimeoutMs) || this.commandTimeoutMs);
            let timer = null;
            let settled = false;
            const pending = {
                resolve: value => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    resolve(value);
                },
                reject: error => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    reject(error);
                }
            };
            this.pending.push(pending);
            timer = setTimeout(() => {
                const error = new Error(`Redis command timeout after ${timeoutMs}ms`);
                this._failPending(error);
                this.socket?.destroy(error);
            }, timeoutMs);
            this.socket.write(encodeCommand(parts), error => {
                if (!error) return;
                const index = this.pending.indexOf(pending);
                if (index >= 0) this.pending.splice(index, 1);
                pending.reject(error);
            });
        });
    }

    async commandPipeline(commands, options = {}) {
        if (!Array.isArray(commands) || commands.length === 0) return [];
        return Promise.all(commands.map(parts => this.command(parts, options)));
    }

    async evalScript(name, script, keys = [], args = []) {
        const hash = this.scriptHashes.get(name) || createHash('sha1').update(script).digest('hex');
        this.scriptHashes.set(name, hash);
        try {
            return await this.command(['EVALSHA', hash, keys.length, ...keys, ...args]);
        } catch (error) {
            if (!/NOSCRIPT/i.test(error.message)) throw error;
            return this.command(['EVAL', script, keys.length, ...keys, ...args]);
        }
    }

    async close() {
        const socket = this.socket;
        this.socket = null;
        if (!socket || socket.destroyed) return;
        await new Promise(resolve => {
            socket.once('close', resolve);
            socket.end();
        });
    }
}
