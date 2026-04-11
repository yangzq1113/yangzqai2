/**
 * WebSocket Proxy — replaces unstable HTTP long-polling with a persistent WS
 * channel for generate requests (LLM + image). The frontend monkey-patches
 * window.fetch so that matched URLs are transparently tunnelled over WS while
 * the rest of the app sees a normal Response object.
 *
 * Key feature: disconnect recovery. When the WS drops mid-stream, the backend
 * keeps the localhost fetch running and buffers chunks. When the client
 * reconnects and sends a "resume" message, buffered data is replayed and
 * live streaming continues seamlessly.
 *
 * Protocol (JSON over WS):
 *
 *   Client → Server  { type:"request",  id, url, method, headers, body }
 *   Client → Server  { type:"resume",   id }                // reconnect recovery
 *   Client → Server  { type:"abort",    id }
 *   Client → Server  { type:"ping" }
 *
 *   Server → Client  { type:"head",     id, status, headers }
 *   Server → Client  { type:"chunk",    id, data }          // streaming body (base64)
 *   Server → Client  { type:"end",      id }                // body finished
 *   Server → Client  { type:"error",    id, message }
 *   Server → Client  { type:"pong" }
 */

import { WebSocketServer } from 'ws';
import { color } from './util.js';

/** @type {WebSocketServer|null} */
let wss = null;

/**
 * Global job registry — survives WS reconnects.
 * Key: request ID, Value: Job object
 * @type {Map<string, Job>}
 */
const jobs = new Map();

const JOB_ORPHAN_TTL = 5 * 60 * 1000;  // 5 min — cleanup orphaned (disconnected + idle) jobs
const JOB_CLEANUP_INTERVAL = 60_000;   // check every 60s

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {AbortController} ac
 * @property {import('ws').WebSocket|null} ws  — current WS (null if disconnected)
 * @property {boolean} headSent
 * @property {object|null} head               — { status, headers }
 * @property {string[]} buffer                — buffered base64 chunks
 * @property {boolean} done                   — response fully received
 * @property {string|null} error              — error message if failed
 * @property {number} lastActivity             — updated on every chunk/head/end
 * @property {object} ctx                     — { cookie, csrfToken, localOrigin, originalHost }
 */

/**
 * Initialize the WS proxy on every HTTP(S) server instance.
 * @param {import('http').Server[]} servers
 */
export function initWsProxy(servers) {
    wss = new WebSocketServer({ noServer: true });

    for (const server of servers) {
        server.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (url.pathname !== '/ws/proxy') return;

            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        });
    }

    wss.on('connection', handleConnection);

    // Periodic cleanup of orphaned jobs
    setInterval(cleanupJobs, JOB_CLEANUP_INTERVAL);

    console.log(color.green('WebSocket proxy initialized on /ws/proxy'));
}

function cleanupJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
        // Only clean up orphaned jobs: no WS attached AND idle for too long
        // Active jobs (ws connected or recently active) are never killed by cleanup
        if (!job.ws && now - job.lastActivity > JOB_ORPHAN_TTL) {
            job.ac.abort();
            jobs.delete(id);
        }
    }
}

/**
 * Handle a single WS connection.
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} req
 */
function handleConnection(ws, req) {
    const cookie = req.headers.cookie || '';
    const upgradeUrl = new URL(req.url, `http://${req.headers.host}`);
    const csrfToken = upgradeUrl.searchParams.get('csrf') || '';
    const originalHost = req.headers.host || 'localhost';

    // Build local origin from actual server socket
    const addr = req.socket.server?.address();
    const protocol = req.socket.encrypted ? 'https' : 'http';
    let localOrigin;
    if (addr && typeof addr === 'object') {
        const host = (addr.family === 'IPv6' || addr.address === '::') ? '127.0.0.1' : (addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address);
        localOrigin = `${protocol}://${host}:${addr.port}`;
    } else {
        localOrigin = `${protocol}://${originalHost}`;
    }

    const ctx = { cookie, csrfToken, localOrigin, originalHost };

    /** Track which job IDs this connection owns */
    const ownedJobs = new Set();

    // Server-side keepalive: send WS protocol-level pings every 30s
    // to detect dead TCP connections (NAT timeout, network switch, etc.)
    const wsPingInterval = setInterval(() => {
        if (ws.readyState === 1) ws.ping();
    }, 30000);

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (msg.type === 'ping') {
            wsSend(ws, { type: 'pong' });
            return;
        }

        if (msg.type === 'abort') {
            const job = jobs.get(msg.id);
            if (job) {
                job.ac.abort();
                jobs.delete(msg.id);
                ownedJobs.delete(msg.id);
            }
            return;
        }

        if (msg.type === 'resume') {
            handleResume(ws, msg.id, ownedJobs, msg.fromChunk);
            return;
        }

        if (msg.type === 'request') {
            const id = msg.id;
            ownedJobs.add(id);
            startJob(ws, msg, ctx);
        }
    });

    ws.on('close', () => {
        clearInterval(wsPingInterval);
        // Detach WS from all owned jobs — but do NOT abort them.
        // The backend fetch continues running, buffering chunks.
        for (const id of ownedJobs) {
            const job = jobs.get(id);
            if (job) {
                job.ws = null;
            }
        }
        ownedJobs.clear();
    });

    ws.on('error', (err) => {
        console.error('[ws-proxy] connection error:', err.message);
    });
}

/**
 * Resume a job after WS reconnect — replay buffered data.
 */
function handleResume(ws, id, ownedJobs, fromChunk = 0) {
    const job = jobs.get(id);
    if (!job) {
        // Job expired or never existed
        wsSend(ws, { type: 'error', id, message: 'Job not found (expired or invalid)' });
        return;
    }

    // Re-attach WS to this job
    job.ws = ws;
    ownedJobs.add(id);

    // Replay head if we have it
    if (job.head) {
        wsSend(ws, { type: 'head', id, status: job.head.status, headers: job.head.headers });
    }

    // Replay buffered chunks from the requested offset to avoid duplicates.
    const start = Number.isFinite(fromChunk) ? Math.max(0, Math.floor(fromChunk)) : 0;
    for (let i = start; i < job.buffer.length; i++) {
        const b64 = job.buffer[i];
        wsSend(ws, { type: 'chunk', id, data: b64 });
    }

    // If job already finished, send end/error
    if (job.done) {
        if (job.error) {
            wsSend(ws, { type: 'error', id, message: job.error });
        } else {
            wsSend(ws, { type: 'end', id });
        }
        jobs.delete(id);
        ownedJobs.delete(id);
    }
    // Otherwise, the streaming loop in startJob will continue pushing
    // new chunks to this ws now that job.ws is set again.
}

/**
 * Start a new proxy job: fetch locally, stream response, buffer on disconnect.
 */
async function startJob(ws, msg, ctx) {
    const { id, url, method, headers: clientHeaders, body } = msg;
    const ac = new AbortController();

    /** @type {Job} */
    const job = {
        id,
        ac,
        ws,
        headSent: false,
        head: null,
        buffer: [],
        done: false,
        error: null,
        lastActivity: Date.now(),
        ctx,
    };
    jobs.set(id, job);

    try {
        const fetchHeaders = { ...clientHeaders };
        fetchHeaders['cookie'] = ctx.cookie;
        fetchHeaders['host'] = ctx.originalHost;
        if (!fetchHeaders['x-csrf-token'] && !fetchHeaders['X-CSRF-Token'] && ctx.csrfToken) {
            fetchHeaders['x-csrf-token'] = ctx.csrfToken;
        }

        const fetchUrl = `${ctx.localOrigin}${url}`;
        const resp = await fetch(fetchUrl, {
            method: method || 'POST',
            headers: fetchHeaders,
            body: body || undefined,
            signal: ac.signal,
            redirect: 'follow',
        });

        // Store and send head
        const respHeaders = {};
        resp.headers.forEach((v, k) => { respHeaders[k] = v; });
        job.head = { status: resp.status, headers: respHeaders };
        job.headSent = true;
        wsSend(job.ws, { type: 'head', id, status: resp.status, headers: respHeaders });

        // Stream body chunks
        if (resp.body) {
            const reader = resp.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const b64 = Buffer.from(value).toString('base64');
                    // Always buffer (for resume support)
                    job.buffer.push(b64);
                    job.lastActivity = Date.now();
                    // Send to WS if connected
                    wsSend(job.ws, { type: 'chunk', id, data: b64 });
                }
            } catch (err) {
                if (err.name !== 'AbortError') {
                    job.error = `Stream read error: ${err.message}`;
                    job.done = true;
                    wsSend(job.ws, { type: 'error', id, message: job.error });
                    return;
                }
            }
        }

        job.done = true;
        wsSend(job.ws, { type: 'end', id });

        // If client is connected, clean up immediately
        if (job.ws) {
            jobs.delete(id);
        }
        // If disconnected, keep job alive for resume (TTL cleanup will handle it)
    } catch (err) {
        if (err.name !== 'AbortError') {
            job.error = err.message;
            job.done = true;
            wsSend(job.ws, { type: 'error', id, message: err.message });
            if (job.ws) {
                jobs.delete(id);
            }
        } else {
            // Aborted — clean up
            jobs.delete(id);
        }
    }
}

/**
 * Safe WS send — silently drops if ws is null or not open.
 */
function wsSend(ws, obj) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
    }
}
