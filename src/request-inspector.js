// SPDX-License-Identifier: AGPL-3.0-or-later
// Request Inspector — per-user ring buffer for generation request diagnostics.

import express from 'express';
import { randomUUID } from 'node:crypto';

const RING_BUFFER_SIZE = 200;

/** @type {Map<string, InspectorEntry[]>} handle -> entries */
const buffers = new Map();

function getBuffer(handle) {
 if (!buffers.has(handle)) {
 buffers.set(handle, []);
 }
 return buffers.get(handle);
}

function pushEntry(handle, entry) {
 const buf = getBuffer(handle);
 buf.push(entry);
 if (buf.length > RING_BUFFER_SIZE) {
 buf.shift();
 }
}

/**
 * Start tracking a generation request. Call at the top of /generate.
 * Attaches `request.__inspectorId` for later completion.
 * @param {import('express').Request} request
 */
export function startInspection(request) {
 const handle = String(request?.user?.profile?.handle || '');
 if (!handle) return;

 const body = request.body || {};
 const messages = Array.isArray(body.messages) ? body.messages : [];

 const entry = {
 id: randomUUID(),
 handle,
 timestamp: Date.now(),
 source: String(body.chat_completion_source || body.api_type || 'unknown'),
 model: String(body.model || ''),
 stream: Boolean(body.stream),
 messageCount: messages.length,
 messageRoles: messages.map(m => String(m?.role || '?')),
 promptCharLength: messages.reduce((sum, m) => {
 const content = m?.content;
 if (typeof content === 'string') return sum + content.length;
 if (Array.isArray(content)) {
 return sum + content.reduce((s, part) => {
 if (typeof part === 'string') return s + part.length;
 if (part?.text) return s + String(part.text).length;
 if (part?.type === 'image_url' || part?.type === 'image') return s + 100;
 return s;
 }, 0);
 }
 return sum;
 }, 0),
 maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
 fullMessages: messages,
 usage: {
 prompt_tokens: null,
 completion_tokens: null,
 total_tokens: null,
 cache_read: null,
 cache_write: null,
 },
 durationMs: null,
 status: 'running',
 httpStatus: null,
 error: '',
 };

 pushEntry(handle, entry);
 request.__inspectorId = entry.id;
 request.__inspectorTimestamp = entry.timestamp;
}

/**
 * Find the entry for a request.
 * @param {import('express').Request} request
 * @returns {object|null}
 */
function findEntry(request) {
 const handle = String(request?.user?.profile?.handle || '');
 const id = request?.__inspectorId;
 if (!handle || !id) return null;
 const buf = getBuffer(handle);
 for (let i = buf.length - 1; i >= 0; i--) {
 if (buf[i].id === id) return buf[i];
 }
 return null;
}

// ---- Usage extraction helpers ----

function extractUsageFromOAI(payload) {
 const usage = payload?.usage;
 if (!usage || typeof usage !== 'object') return {};
 return {
 prompt_tokens: usage.prompt_tokens ?? null,
 completion_tokens: usage.completion_tokens ?? null,
 total_tokens: usage.total_tokens ?? null,
 cache_read: usage.prompt_tokens_details?.cached_tokens
 ?? usage.cache_read_input_tokens
 ?? usage.prompt_cache_hit_tokens
 ?? null,
 cache_write: usage.cache_creation_input_tokens
 ?? usage.prompt_cache_miss_tokens
 ?? null,
 };
}

function extractUsageFromClaude(payload) {
 const usage = payload?.usage;
 if (!usage || typeof usage !== 'object') return {};
 return {
 prompt_tokens: usage.input_tokens ?? null,
 completion_tokens: usage.output_tokens ?? null,
 total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) || null,
 cache_read: usage.cache_read_input_tokens ?? null,
 cache_write: usage.cache_creation_input_tokens ?? null,
 };
}

function extractUsageFromGemini(payload) {
 const meta = payload?.usageMetadata;
 if (!meta || typeof meta !== 'object') return {};
 return {
 prompt_tokens: meta.promptTokenCount ?? null,
 completion_tokens: meta.candidatesTokenCount ?? null,
 total_tokens: meta.totalTokenCount ?? null,
 cache_read: meta.cachedContentTokenCount ?? null,
 cache_write: null,
 };
}

/**
 * Extract usage from SSE stream events.
 * @param {string[]} events
 * @param {string} source
 * @returns {object}
 */
export function extractUsageFromStreamEvents(events, source) {
 if (!Array.isArray(events) || events.length === 0) return {};

 for (let i = events.length - 1; i >= 0; i--) {
 const raw = events[i];
 if (!raw || raw === '[DONE]') continue;

 let parsed;
 try {
 parsed = JSON.parse(raw);
 } catch {
 continue;
 }

 if (parsed?.luker) continue;

 if (source === 'claude') {
 if (parsed?.type === 'message_delta' && parsed?.usage) {
 return extractUsageFromClaude({ usage: parsed.usage });
 }
 if (parsed?.type === 'message_start' && parsed?.message?.usage) {
 return extractUsageFromClaude({ usage: parsed.message.usage });
 }
 }

 if (source === 'makersuite' || source === 'vertexai') {
 if (parsed?.usageMetadata) {
 return extractUsageFromGemini(parsed);
 }
 }

 if (parsed?.usage) {
 return extractUsageFromOAI(parsed);
 }
 }

 return {};
}

/**
 * Complete an inspection with success + usage data from a non-streaming response.
 * @param {import('express').Request} request
 * @param {object} payload
 * @param {object} [rawApiResponse]
 */
export function completeInspection(request, payload, rawApiResponse) {
 const entry = findEntry(request);
 if (!entry) return;

 entry.status = 'success';
 entry.durationMs = Date.now() - entry.timestamp;
 entry.httpStatus = 200;

 const source = entry.source;
 let usage = {};

 if (rawApiResponse) {
 if (source === 'claude') {
 usage = extractUsageFromClaude(rawApiResponse);
 } else if (source === 'makersuite' || source === 'vertexai') {
 usage = extractUsageFromGemini(rawApiResponse);
 }
 }

 if (!usage.prompt_tokens) {
 const oaiUsage = extractUsageFromOAI(payload);
 if (oaiUsage.prompt_tokens) {
 usage = oaiUsage;
 }
 }

 Object.assign(entry.usage, usage);
}

/**
 * Complete an inspection from streaming events.
 * @param {import('express').Request} request
 * @param {string[]} events
 */
export function completeInspectionFromStream(request, events) {
 const entry = findEntry(request);
 if (!entry) return;

 entry.status = 'success';
 entry.durationMs = Date.now() - entry.timestamp;
 entry.httpStatus = 200;

 const usage = extractUsageFromStreamEvents(events, entry.source);
 Object.assign(entry.usage, usage);
}

/**
 * Mark an inspection as failed.
 * @param {import('express').Request} request
 * @param {string} errorMessage
 * @param {number} [httpStatus]
 */
export function failInspection(request, errorMessage, httpStatus) {
 const entry = findEntry(request);
 if (!entry) return;

 entry.status = 'error';
 entry.durationMs = Date.now() - entry.timestamp;
 entry.httpStatus = httpStatus ?? null;
 entry.error = String(errorMessage || 'Unknown error');
}

/**
 * Mark an inspection as aborted.
 * @param {import('express').Request} request
 */
export function abortInspection(request) {
 const entry = findEntry(request);
 if (!entry) return;
 if (entry.status !== 'running') return;

 entry.status = 'aborted';
 entry.durationMs = Date.now() - entry.timestamp;
}

// ---- Express Router ----

export const router = express.Router();

router.get('/list', (req, res) => {
 const handle = String(req?.user?.profile?.handle || '');
 if (!handle) return res.status(401).send({ error: 'Unauthorized' });

 const buf = getBuffer(handle);
 const summaries = buf.map(e => ({
 id: e.id,
 timestamp: e.timestamp,
 source: e.source,
 model: e.model,
 stream: e.stream,
 messageCount: e.messageCount,
 promptCharLength: e.promptCharLength,
 maxTokens: e.maxTokens,
 usage: e.usage,
 durationMs: e.durationMs,
 status: e.status,
 httpStatus: e.httpStatus,
 error: e.error,
 }));

 summaries.reverse();
 return res.json(summaries);
});

router.get('/:id', (req, res) => {
 const handle = String(req?.user?.profile?.handle || '');
 if (!handle) return res.status(401).send({ error: 'Unauthorized' });

 const buf = getBuffer(handle);
 const entry = buf.find(e => e.id === req.params.id);
 if (!entry) return res.status(404).send({ error: 'Not found' });

 return res.json(entry);
});

router.get('/:id/export', (req, res) => {
 const handle = String(req?.user?.profile?.handle || '');
 if (!handle) return res.status(401).send({ error: 'Unauthorized' });

 const buf = getBuffer(handle);
 const entry = buf.find(e => e.id === req.params.id);
 if (!entry) return res.status(404).send({ error: 'Not found' });

 const filename = `request-${entry.id.slice(0, 8)}-${entry.timestamp}.json`;
 res.setHeader('Content-Type', 'application/json');
 res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
 return res.send(JSON.stringify(entry, null, 2));
});
