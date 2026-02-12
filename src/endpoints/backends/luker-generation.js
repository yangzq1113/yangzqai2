import path from 'node:path';
import sanitize from 'sanitize-filename';

import { appendMessagesToChatFile } from '../chats.js';

const generationJobs = new Map();
const LUKER_GENERATION_JOB_MAX_ITEMS = 128;
const LUKER_GENERATION_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const LUKER_GENERATION_JOB_MAX_EVENTS = 8000;

function normalizePersistJsonlFileName(fileName) {
    const raw = String(fileName || '').trim();
    if (!raw) {
        return '';
    }
    const withExt = path.extname(raw) ? raw : `${raw}.jsonl`;
    return sanitize(path.basename(withExt));
}

function normalizePersistAvatarDirectory(avatarUrl) {
    const raw = String(avatarUrl || '').replace('.png', '').trim();
    if (!raw) {
        return '';
    }
    return sanitize(path.basename(raw));
}

function extractTextFromOpenAIMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') {
                return part;
            }
            if (typeof part?.text === 'string') {
                return part.text;
            }
            if (typeof part?.content === 'string') {
                return part.content;
            }
            return '';
        }).join('');
    }

    if (content && typeof content === 'object') {
        if (typeof content.text === 'string') {
            return content.text;
        }
        if (typeof content.content === 'string') {
            return content.content;
        }
    }

    return '';
}

export function extractTextFromFinalPayload(payload) {
    if (!payload) {
        return '';
    }

    if (typeof payload === 'string') {
        return payload;
    }

    if (typeof payload !== 'object') {
        return '';
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    if (choice) {
        if (typeof choice?.message?.content === 'string') {
            return choice.message.content;
        }
        if (Array.isArray(choice?.message?.content)) {
            return extractTextFromOpenAIMessageContent(choice.message.content);
        }
        if (typeof choice?.text === 'string') {
            return choice.text;
        }
        if (typeof choice?.delta?.content === 'string') {
            return choice.delta.content;
        }
        if (Array.isArray(choice?.delta?.content)) {
            return extractTextFromOpenAIMessageContent(choice.delta.content);
        }
    }

    const result = Array.isArray(payload?.results) ? payload.results[0] : null;
    if (result) {
        if (typeof result?.text === 'string') {
            return result.text;
        }
        if (typeof result?.content === 'string') {
            return result.content;
        }
        if (typeof result?.message?.content === 'string') {
            return result.message.content;
        }
    }

    if (typeof payload.response === 'string') {
        return payload.response;
    }
    if (typeof payload.content === 'string') {
        return payload.content;
    }
    if (typeof payload.token === 'string') {
        return payload.token;
    }
    if (typeof payload.text === 'string') {
        return payload.text;
    }
    if (typeof payload.output === 'string') {
        return payload.output;
    }

    return '';
}

export function extractTextFromStreamingFrameData(rawData) {
    if (!rawData || rawData === '[DONE]') {
        return '';
    }

    try {
        const parsed = JSON.parse(rawData);
        if (parsed?.luker && typeof parsed.luker === 'object') {
            return '';
        }
        return extractTextFromFinalPayload(parsed);
    } catch {
        return '';
    }
}

function pruneGenerationJobs() {
    const now = Date.now();
    for (const [key, job] of generationJobs.entries()) {
        const updatedAt = Number(job?.updatedAt || job?.createdAt || 0);
        if (!updatedAt || (now - updatedAt) > LUKER_GENERATION_JOB_TTL_MS) {
            generationJobs.delete(key);
        }
    }

    while (generationJobs.size > LUKER_GENERATION_JOB_MAX_ITEMS) {
        const oldestKey = generationJobs.keys().next().value;
        generationJobs.delete(oldestKey);
    }
}

export function getPersistChatKey(persistTarget) {
    if (!persistTarget || typeof persistTarget !== 'object') {
        return '';
    }

    if (persistTarget.kind === 'group') {
        return `group:${String(persistTarget.id || '')}`;
    }

    const avatar = String(persistTarget.avatar_url || '');
    const fileName = String(persistTarget.file_name || '');
    if (!avatar || !fileName) {
        return '';
    }
    return `char:${avatar}:${fileName}`;
}

export function createGenerationJob(request, options) {
    if (!options || typeof options !== 'object') {
        return null;
    }

    const jobId = typeof options.job_id === 'string' && options.job_id.trim()
        ? options.job_id.trim()
        : '';
    if (!jobId) {
        return null;
    }

    const now = Date.now();
    const persistTarget = options.persist_target && typeof options.persist_target === 'object'
        ? options.persist_target
        : null;
    const chatKey = getPersistChatKey(persistTarget);
    const existing = generationJobs.get(jobId);
    const job = existing || {
        id: jobId,
        handle: request.user.profile.handle,
        createdAt: now,
        updatedAt: now,
        status: 'running',
        text: '',
        events: [],
        lastSeq: 0,
        error: '',
        persisted: false,
        persistTarget,
        chatKey,
    };

    job.status = 'running';
    job.updatedAt = now;
    job.error = '';
    job.persistTarget = persistTarget;
    job.chatKey = chatKey;
    if (!Array.isArray(job.events)) {
        job.events = [];
    }

    generationJobs.set(jobId, job);
    pruneGenerationJobs();
    return job;
}

export function attachJobToRequest(request, job) {
    if (!request || typeof request !== 'object') {
        return;
    }
    request.lukerGenerationJob = job || null;
}

export function getJobFromRequest(request) {
    return request?.lukerGenerationJob || null;
}

export function appendGenerationEvent(job, rawData) {
    if (!job) {
        return;
    }

    const nextSeq = Number(job.lastSeq || 0) + 1;
    job.lastSeq = nextSeq;
    job.events.push({ seq: nextSeq, data: rawData, ts: Date.now() });
    if (job.events.length > LUKER_GENERATION_JOB_MAX_EVENTS) {
        job.events.splice(0, job.events.length - LUKER_GENERATION_JOB_MAX_EVENTS);
    }
    job.updatedAt = Date.now();

    const deltaText = extractTextFromStreamingFrameData(rawData);
    if (deltaText) {
        job.text += deltaText;
    }
}

export function failGenerationJob(job, errorMessage = 'Unknown error occurred') {
    if (!job) {
        return;
    }
    job.status = 'failed';
    job.error = String(errorMessage || 'Unknown error occurred');
    job.updatedAt = Date.now();
    job.finishedAt = Date.now();
}

async function persistGeneratedReply(request, persistTarget, text, generationId = '', modelName = '') {
    if (!persistTarget || typeof persistTarget !== 'object') {
        return false;
    }

    const finalText = String(text || '');
    if (!finalText) {
        return false;
    }

    const message = {
        name: String(persistTarget.char_name || request.body.char_name || 'Assistant'),
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: finalText,
        extra: {
            api: String(request.body?.chat_completion_source || request.body?.api_type || request.body?.api || 'unknown'),
            model: modelName || request.body?.model,
            luker_server_persisted: true,
            ...(generationId ? { luker_generation_id: generationId } : {}),
        },
    };

    if (persistTarget.kind === 'group') {
        const groupId = String(persistTarget.id || '');
        if (!groupId) {
            return false;
        }

        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${groupId}.jsonl`));
        await appendMessagesToChatFile({
            filePath: chatFilePath,
            messages: [message],
            chatMetadata: persistTarget.chat_metadata || {},
            integritySlug: persistTarget.integrity,
            force: Boolean(persistTarget.force),
        });
        return true;
    }

    if (persistTarget.kind === 'character') {
        const avatar = normalizePersistAvatarDirectory(persistTarget.avatar_url);
        const fileName = normalizePersistJsonlFileName(persistTarget.file_name);
        if (!avatar || !fileName) {
            return false;
        }

        const chatFilePath = path.join(
            request.user.directories.chats,
            avatar,
            fileName,
        );
        await appendMessagesToChatFile({
            filePath: chatFilePath,
            messages: [message],
            chatMetadata: persistTarget.chat_metadata || {},
            integritySlug: persistTarget.integrity,
            force: Boolean(persistTarget.force),
        });
        return true;
    }

    return false;
}

export async function completeGenerationJobFromText(request, job, text, modelName = '') {
    if (!job) {
        return false;
    }

    const finalText = String(text || '');
    job.text = finalText || job.text || '';
    job.status = 'completed';
    job.updatedAt = Date.now();
    job.finishedAt = Date.now();
    job.persisted = await persistGeneratedReply(request, job.persistTarget, job.text, job.id, modelName);
    return Boolean(job.persisted);
}

export async function completeGenerationJobFromPayload(request, job, payload, modelName = '') {
    const text = extractTextFromFinalPayload(payload);
    return await completeGenerationJobFromText(request, job, text, modelName);
}

export function bindRequestCloseAbort(request, controller, options = {}) {
    const onAbortClose = typeof options.onAbortClose === 'function' ? options.onAbortClose : null;
    const keepAliveWhenJob = options.keepAliveWhenJob !== false;
    const hasJob = keepAliveWhenJob && Boolean(getJobFromRequest(request));

    request.socket.removeAllListeners('close');
    request.socket.on('close', async function () {
        if (hasJob) {
            return;
        }
        if (onAbortClose) {
            await onAbortClose();
        }
        controller.abort();
    });
}

export async function forwardStreamingWithGenerationJob(fetchResponse, response, request, job, options = {}) {
    const modelName = String(options.modelName || request.body?.model || '');
    let statusCode = fetchResponse.status;
    if (statusCode === 401) {
        statusCode = 400;
    }

    response.statusCode = statusCode;
    response.statusMessage = fetchResponse.statusText;
    response.setHeader('x-luker-generation-id', job.id);
    const contentType = fetchResponse.headers.get('content-type');
    if (contentType) {
        response.setHeader('content-type', contentType);
    }

    let clientClosed = false;
    response.socket?.on('close', () => {
        clientClosed = true;
    });

    if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text().catch(() => '');
        failGenerationJob(job, `${fetchResponse.status} ${fetchResponse.statusText}`.trim());
        if (!clientClosed && !response.writableEnded) {
            response.end(errorText || '');
        }
        return;
    }

    let buffer = '';
    if (fetchResponse.body) {
        for await (const chunk of fetchResponse.body) {
            const chunkText = Buffer.from(chunk).toString('utf8');
            if (!clientClosed && !response.writableEnded) {
                response.write(chunkText);
            }

            buffer += chunkText.replace(/\r\n/g, '\n');
            let delimiterIndex = buffer.indexOf('\n\n');
            while (delimiterIndex !== -1) {
                const frame = buffer.slice(0, delimiterIndex);
                buffer = buffer.slice(delimiterIndex + 2);
                const dataLines = frame
                    .split('\n')
                    .map(line => line.trimEnd())
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trimStart());
                if (dataLines.length > 0) {
                    appendGenerationEvent(job, dataLines.join('\n'));
                }
                delimiterIndex = buffer.indexOf('\n\n');
            }
        }
    }

    if (buffer.trim()) {
        const dataLines = buffer
            .split('\n')
            .map(line => line.trimEnd())
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart());
        if (dataLines.length > 0) {
            appendGenerationEvent(job, dataLines.join('\n'));
        }
    }

    const persisted = await completeGenerationJobFromText(request, job, job.text, modelName);
    const completionEvent = JSON.stringify({
        luker: {
            generation_id: job.id,
            persisted,
            status: job.status,
        },
    });
    appendGenerationEvent(job, completionEvent);
    if (!clientClosed && !response.writableEnded) {
        response.write(`data: ${completionEvent}\n\n`);
        response.end();
    }
}

export function getActiveGenerationJobsForRequest(request, persistTarget) {
    const chatKey = getPersistChatKey(persistTarget);
    if (!chatKey) {
        return [];
    }
    pruneGenerationJobs();
    const handle = request.user.profile.handle;
    return Array.from(generationJobs.values())
        .filter(job => job.handle === handle && job.chatKey === chatKey && ['running', 'queued'].includes(job.status))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .map(job => ({
            id: job.id,
            status: job.status,
            text: job.text,
            last_seq: job.lastSeq,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
        }));
}

export function getGenerationJobForRequest(request, jobId) {
    pruneGenerationJobs();
    const job = generationJobs.get(String(jobId || ''));
    if (!job || job.handle !== request.user.profile.handle) {
        return null;
    }
    return job;
}
