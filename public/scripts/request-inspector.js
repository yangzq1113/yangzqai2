/**
 * Request Inspector — DevTools-like Network panel for generation requests.
 * Shows per-user request history with timing, token usage, and full message export.
 * Supports both chat (LLM) and image generation requests.
 */

import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';

const MODULE_NAME = 'RequestInspector';
let cachedList = [];
let currentDetailId = null;
let currentFilter = 'all'; // 'all' | 'chat' | 'image'

function formatTimestamp(ts) {
 const d = new Date(ts);
 return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms) {
 if (ms == null) return '\u2014';
 if (ms < 1000) return `${ms}ms`;
 return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n) {
 if (n == null) return '\u2014';
 if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
 return String(n);
}

function formatBytes(n) {
 if (n == null) return '\u2014';
 if (n < 1024) return `${n}B`;
 if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
 return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function statusIcon(status) {
 switch (status) {
 case 'success': return '<span class="ri-status ri-success">\u2713</span>';
 case 'error': return '<span class="ri-status ri-error">\u2717</span>';
 case 'aborted': return '<span class="ri-status ri-aborted">\u2298</span>';
 case 'running': return '<span class="ri-status ri-running">\u27F3</span>';
 default: return '<span class="ri-status">?</span>';
 }
}

function typeIcon(type) {
 return type === 'image'
 ? '<span class="ri-type-badge ri-type-image" title="Image">\uD83C\uDFA8</span>'
 : '<span class="ri-type-badge ri-type-chat" title="Chat">\uD83D\uDCAC</span>';
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

function buildFilterBar() {
 return `
 <div class="ri-filter-bar">
 <button class="ri-filter-btn menu_button ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">${t`All`}</button>
 <button class="ri-filter-btn menu_button ${currentFilter === 'chat' ? 'active' : ''}" data-filter="chat">\uD83D\uDCAC ${t`Chat`}</button>
 <button class="ri-filter-btn menu_button ${currentFilter === 'image' ? 'active' : ''}" data-filter="image">\uD83C\uDFA8 ${t`Image`}</button>
 </div>`;
}

function getFilteredItems(items) {
 if (currentFilter === 'all') return items;
 return items.filter(item => (item.type || 'chat') === currentFilter);
}

function buildInfoCell(item) {
 const type = item.type || 'chat';
 if (type === 'image') {
 const dims = (item.width && item.height) ? `${item.width}\u00D7${item.height}` : '';
 const promptSnippet = escapeHtml((item.prompt || '').slice(0, 40));
 return `<span class="ri-info-prompt" title="${escapeHtml(item.prompt || '')}">${promptSnippet}</span>${dims ? ` <span class="ri-info-dims">${dims}</span>` : ''}`;
 }
 const msgs = item.messageCount != null ? `${item.messageCount} ${t`msgs`}` : '';
 const tokens = item.usage?.prompt_tokens != null ? ` \u00B7 ${formatTokens(item.usage.prompt_tokens)}\u2192${formatTokens(item.usage.completion_tokens)}` : '';
 return `${msgs}${tokens}`;
}

function buildListHtml(items) {
 const filtered = getFilteredItems(items);
 let html = buildFilterBar();

 if (!filtered.length) {
 html += `<div class="ri-empty">${t`No generation requests recorded yet.`}</div>`;
 return html;
 }

 html += `
 <div class="ri-table-wrap">
 <table class="ri-table">
 <thead>
 <tr>
 <th>${t`Time`}</th>
 <th>${t`Type`}</th>
 <th>${t`Source`}</th>
 <th>${t`Model`}</th>
 <th>${t`Info`}</th>
 <th>${t`Duration`}</th>
 <th>${t`Status`}</th>
 </tr>
 </thead>
 <tbody>`;

 for (const item of filtered) {
 const type = item.type || 'chat';
 const modelShort = (item.model || '').replace(/^(.*\/)?/, '').slice(0, 28);
 html += `
 <tr class="ri-row" data-id="${escapeHtml(item.id)}">
 <td class="ri-mono">${formatTimestamp(item.timestamp)}</td>
 <td>${typeIcon(type)}</td>
 <td>${escapeHtml(item.source)}</td>
 <td title="${escapeHtml(item.model)}">${escapeHtml(modelShort)}</td>
 <td class="ri-info-cell">${buildInfoCell(item)}</td>
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

function buildChatDetailHtml(detail) {
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
 <button class="ri-back menu_button">\u2190 ${t`Back`}</button>
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
 <tr><td>${t`Max Tokens`}</td><td>${detail.maxTokens ?? '\u2014'}</td></tr>
 </table>
 </div>

 <div class="ri-detail-section">
 <h4>${t`Response`}</h4>
 <table class="ri-kv">
 <tr><td>${t`Status`}</td><td>${statusIcon(detail.status)} ${escapeHtml(detail.status)}</td></tr>
 <tr><td>HTTP</td><td>${detail.httpStatus ?? '\u2014'}</td></tr>
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

function buildImageDetailHtml(detail) {
 const dims = (detail.width && detail.height) ? `${detail.width} \u00D7 ${detail.height}` : '\u2014';

 return `
 <div class="ri-detail">
 <div class="ri-detail-header">
 <button class="ri-back menu_button">\u2190 ${t`Back`}</button>
 <button class="ri-export menu_button" data-id="${escapeHtml(detail.id)}">${t`Export JSON`}</button>
 </div>

 <div class="ri-detail-grid">
 <div class="ri-detail-section">
 <h4>${t`Image Generation`}</h4>
 <table class="ri-kv">
 <tr><td>${t`Source`}</td><td>${escapeHtml(detail.source)}</td></tr>
 <tr><td>${t`Model`}</td><td>${escapeHtml(detail.model || '\u2014')}</td></tr>
 <tr><td>${t`Dimensions`}</td><td>${dims}</td></tr>
 <tr><td>${t`Steps`}</td><td>${detail.steps ?? '\u2014'}</td></tr>
 <tr><td>${t`CFG Scale`}</td><td>${detail.cfgScale ?? '\u2014'}</td></tr>
 <tr><td>${t`Seed`}</td><td>${detail.seed ?? '\u2014'}</td></tr>
 <tr><td>${t`Sampler`}</td><td>${escapeHtml(detail.sampler || '\u2014')}</td></tr>
 </table>
 </div>

 <div class="ri-detail-section">
 <h4>${t`Response`}</h4>
 <table class="ri-kv">
 <tr><td>${t`Status`}</td><td>${statusIcon(detail.status)} ${escapeHtml(detail.status)}</td></tr>
 <tr><td>HTTP</td><td>${detail.httpStatus ?? '\u2014'}</td></tr>
 <tr><td>${t`Duration`}</td><td>${formatDuration(detail.durationMs)}</td></tr>
 <tr><td>${t`Output Format`}</td><td>${escapeHtml(detail.outputFormat || '\u2014')}</td></tr>
 <tr><td>${t`Output Size`}</td><td>${formatBytes(detail.outputSizeBytes)}</td></tr>
 ${detail.error ? `<tr><td>${t`Error`}</td><td class="ri-error-text">${escapeHtml(detail.error)}</td></tr>` : ''}
 </table>
 </div>
 </div>

 <div class="ri-detail-section">
 <h4>${t`Prompt`}</h4>
 <pre class="ri-img-prompt">${escapeHtml(detail.prompt || t`(empty)`)}</pre>
 </div>

 ${detail.negativePrompt ? `
 <div class="ri-detail-section">
 <h4>${t`Negative Prompt`}</h4>
 <pre class="ri-img-prompt ri-img-neg-prompt">${escapeHtml(detail.negativePrompt)}</pre>
 </div>` : ''}
 </div>`;
}

function buildDetailHtml(detail) {
 if (!detail) return `<div class="ri-empty">${t`Failed to load request details.`}</div>`;
 const type = detail.type || 'chat';
 return type === 'image' ? buildImageDetailHtml(detail) : buildChatDetailHtml(detail);
}

async function openInspectorPanel() {
 const items = await fetchList();
 const content = $('<div class="ri-container"></div>');
 content.html(buildListHtml(items));

 content.on('click', '.ri-filter-btn', function () {
 currentFilter = $(this).data('filter');
 content.html(buildListHtml(cachedList));
 });

 content.on('click', '.ri-row', async function () {
 const id = $(this).data('id');
 if (!id) return;
 currentDetailId = id;
 content.html(`<div class="ri-loading">${t`Loading...`}</div>`);
 const detail = await fetchDetail(id);
 content.html(buildDetailHtml(detail));
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

 const $logsBtn = $('#server_logs_button');
 if ($logsBtn.length) {
 $logsBtn.after($btn);
 } else {
 $('#account_controls').append($btn);
 }
});
