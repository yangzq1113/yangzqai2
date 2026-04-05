/**
 * Request Inspector — DevTools-like Network panel for generation requests.
 * Shows per-user request history with timing, token usage, and full message export.
 */

import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';

const MODULE_NAME = 'RequestInspector';
let cachedList = [];
let currentDetailId = null;

function formatTimestamp(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n) {
    if (n == null) return '—';
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

function statusIcon(status) {
    switch (status) {
        case 'success': return '<span class="ri-status ri-success">✓</span>';
        case 'error': return '<span class="ri-status ri-error">✗</span>';
        case 'aborted': return '<span class="ri-status ri-aborted">⊘</span>';
        case 'running': return '<span class="ri-status ri-running">⟳</span>';
        default: return '<span class="ri-status">?</span>';
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function fetchList() {
    try {
        const res = await fetch('/api/request-inspector/list');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        cachedList = await res.json();
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to fetch list:`, err);
        cachedList = [];
    }
    return cachedList;
}

async function fetchDetail(id) {
    try {
        const res = await fetch(`/api/request-inspector/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to fetch detail:`, err);
        return null;
    }
}

function buildListHtml(items) {
    if (!items.length) {
        return `<div class="ri-empty">${t`No generation requests recorded yet.`}</div>`;
    }

    let html = `
    <div class="ri-table-wrap">
        <table class="ri-table">
            <thead>
                <tr>
                    <th>${t`Time`}</th>
                    <th>${t`Source`}</th>
                    <th>${t`Model`}</th>
                    <th>${t`Msgs`}</th>
                    <th>${t`Prompt`}</th>
                    <th>${t`Completion`}</th>
                    <th>${t`Duration`}</th>
                    <th>${t`Status`}</th>
                </tr>
            </thead>
            <tbody>`;

    for (const item of items) {
        const modelShort = (item.model || '').replace(/^(.*\/)?/, '').slice(0, 28);
        html += `
                <tr class="ri-row" data-id="${escapeHtml(item.id)}">
                    <td class="ri-mono">${formatTimestamp(item.timestamp)}</td>
                    <td>${escapeHtml(item.source)}</td>
                    <td title="${escapeHtml(item.model)}">${escapeHtml(modelShort)}</td>
                    <td class="ri-num">${item.messageCount}</td>
                    <td class="ri-num">${formatTokens(item.usage?.prompt_tokens)}</td>
                    <td class="ri-num">${formatTokens(item.usage?.completion_tokens)}</td>
                    <td class="ri-mono">${formatDuration(item.durationMs)}</td>
                    <td>${statusIcon(item.status)}</td>
                </tr>`;
    }

    html += `
            </tbody>
        </table>
    </div>`;

    return html;
}

function buildDetailHtml(detail) {
    if (!detail) return `<div class="ri-empty">${t`Failed to load request details.`}</div>`;

    const usage = detail.usage || {};
    const cacheInfo = (usage.cache_read != null || usage.cache_write != null)
        ? `<tr><td>${t`Cache Read`}</td><td>${formatTokens(usage.cache_read)}</td></tr>
           <tr><td>${t`Cache Write`}</td><td>${formatTokens(usage.cache_write)}</td></tr>`
        : '';

    let messagesHtml = '';
    if (Array.isArray(detail.fullMessages)) {
        for (let i = 0; i < detail.fullMessages.length; i++) {
            const msg = detail.fullMessages[i];
            const role = msg?.role || '?';
            const content = typeof msg?.content === 'string'
                ? msg.content
                : JSON.stringify(msg?.content, null, 2);
            const charLen = (content || '').length;
            messagesHtml += `
            <details class="ri-msg">
                <summary class="ri-msg-summary">
                    <span class="ri-msg-index">#${i}</span>
                    <span class="ri-msg-role ri-role-${escapeHtml(role)}">${escapeHtml(role)}</span>
                    <span class="ri-msg-len">${charLen.toLocaleString()} ${t`chars`}</span>
                </summary>
                <pre class="ri-msg-content">${escapeHtml(content || t`(empty)`)}</pre>
            </details>`;
        }
    }

    return `
    <div class="ri-detail">
        <div class="ri-detail-header">
            <button class="ri-back menu_button">← ${t`Back`}</button>
            <button class="ri-export menu_button" data-id="${escapeHtml(detail.id)}">${t`Export JSON`}</button>
        </div>

        <div class="ri-detail-grid">
            <div class="ri-detail-section">
                <h4>${t`Request`}</h4>
                <table class="ri-kv">
                    <tr><td>${t`Source`}</td><td>${escapeHtml(detail.source)}</td></tr>
                    <tr><td>${t`Model`}</td><td>${escapeHtml(detail.model)}</td></tr>
                    <tr><td>${t`Stream`}</td><td>${detail.stream ? t`Yes` : t`No`}</td></tr>
                    <tr><td>${t`Messages`}</td><td>${detail.messageCount}</td></tr>
                    <tr><td>${t`Prompt Chars`}</td><td>${(detail.promptCharLength || 0).toLocaleString()}</td></tr>
                    <tr><td>${t`Max Tokens`}</td><td>${detail.maxTokens ?? '—'}</td></tr>
                </table>
            </div>

            <div class="ri-detail-section">
                <h4>${t`Response`}</h4>
                <table class="ri-kv">
                    <tr><td>${t`Status`}</td><td>${statusIcon(detail.status)} ${escapeHtml(detail.status)}</td></tr>
                    <tr><td>HTTP</td><td>${detail.httpStatus ?? '—'}</td></tr>
                    <tr><td>${t`Duration`}</td><td>${formatDuration(detail.durationMs)}</td></tr>
                    <tr><td>${t`Prompt Tokens`}</td><td>${formatTokens(usage.prompt_tokens)}</td></tr>
                    <tr><td>${t`Completion Tokens`}</td><td>${formatTokens(usage.completion_tokens)}</td></tr>
                    <tr><td>${t`Total Tokens`}</td><td>${formatTokens(usage.total_tokens)}</td></tr>
                    ${cacheInfo}
                    ${detail.error ? `<tr><td>${t`Error`}</td><td class="ri-error-text">${escapeHtml(detail.error)}</td></tr>` : ''}
                </table>
            </div>
        </div>

        <div class="ri-detail-section">
            <h4>${t`Messages`} (${detail.messageCount})</h4>
            <div class="ri-messages">
                ${messagesHtml || `<div class="ri-empty">${t`No messages captured.`}</div>`}
            </div>
        </div>
    </div>`;
}

async function openInspectorPanel() {
    const items = await fetchList();
    const content = $('<div class="ri-container"></div>');
    content.html(buildListHtml(items));

    content.on('click', '.ri-row', async function () {
        const id = $(this).data('id');
        if (!id) return;
        currentDetailId = id;
        content.html(`<div class="ri-loading">${t`Loading...`}</div>`);
        const detail = await fetchDetail(id);
        content.html(buildDetailHtml(detail));
        // Reset scroll position of the popup content container
        content.closest('.popup-content').scrollTop(0);
    });

    content.on('click', '.ri-back', async function () {
        currentDetailId = null;
        const items = await fetchList();
        content.html(buildListHtml(items));
        content.closest('.popup-content').scrollTop(0);
    });

    content.on('click', '.ri-export', function () {
        const id = $(this).data('id');
        if (!id) return;
        const a = document.createElement('a');
        a.href = `/api/request-inspector/${id}/export`;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });

    callGenericPopup(content, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: t`Close`,
        allowVerticalScrolling: true,
    });
}

jQuery(() => {
    const $btn = $(`
        <div id="request_inspector_button" class="margin0 menu_button_icon menu_button">
            <i class="fa-fw fa-solid fa-satellite-dish"></i>
            <span data-i18n="Inspector">Inspector</span>
        </div>
    `);

    $btn.on('click', () => openInspectorPanel());

    // Insert after the Logs button
    const $logsBtn = $('#server_logs_button');
    if ($logsBtn.length) {
        $logsBtn.after($btn);
    } else {
        $('#account_controls').append($btn);
    }
});
