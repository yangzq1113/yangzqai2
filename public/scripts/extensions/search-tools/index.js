// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { getRequestHeaders, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { escapeHtml } from '../../utils.js';

const MODULE_NAME = 'search_tools';
const UI_BLOCK_ID = 'search_tools_settings';
const TOOL_NAMES = Object.freeze({
    SEARCH: 'luker_web_search',
    VISIT: 'luker_web_visit',
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    provider: 'ddg',
    defaultMaxResults: 8,
    defaultVisitMaxChars: 12000,
    safeSearch: 'moderate',
});

function i18n(text) {
    return translate(String(text || ''));
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function normalizeProvider(value) {
    const provider = String(value || '').trim().toLowerCase();
    return provider || 'ddg';
}

function normalizeSafeSearch(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['off', 'moderate', 'strict'].includes(normalized) ? normalized : 'moderate';
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const settings = extension_settings[MODULE_NAME];
    settings.enabled = Boolean(settings.enabled ?? DEFAULT_SETTINGS.enabled);
    settings.provider = normalizeProvider(settings.provider ?? DEFAULT_SETTINGS.provider);
    settings.defaultMaxResults = clampInteger(
        settings.defaultMaxResults ?? DEFAULT_SETTINGS.defaultMaxResults,
        1,
        20,
        DEFAULT_SETTINGS.defaultMaxResults,
    );
    settings.defaultVisitMaxChars = clampInteger(
        settings.defaultVisitMaxChars ?? DEFAULT_SETTINGS.defaultVisitMaxChars,
        500,
        50000,
        DEFAULT_SETTINGS.defaultVisitMaxChars,
    );
    settings.safeSearch = normalizeSafeSearch(settings.safeSearch ?? DEFAULT_SETTINGS.safeSearch);
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function isToolEnabled() {
    return Boolean(getSettings().enabled);
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function fallbackStripHtml(html) {
    return normalizeWhitespace(String(html || '').replace(/<[^>]*>/g, ' '));
}

function htmlToReadableText(html) {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(String(html || ''), 'text/html');
        doc.querySelectorAll('script, style, noscript, svg, canvas, iframe').forEach(node => node.remove());
        const title = normalizeWhitespace(doc.querySelector('title')?.textContent || '');
        const text = normalizeWhitespace(doc.body?.innerText || '');
        return { title, text };
    } catch {
        return { title: '', text: fallbackStripHtml(html) };
    }
}

function normalizeSearchRows(rawRows = []) {
    if (!Array.isArray(rawRows)) {
        return [];
    }
    return rawRows
        .map(item => ({
            title: normalizeWhitespace(item?.title || ''),
            url: normalizeWhitespace(item?.url || ''),
            snippet: normalizeWhitespace(item?.snippet || item?.content || ''),
        }))
        .filter(item => item.title && item.url);
}

async function runDdgSearch({
    query,
    maxResults,
    safeSearch,
    timeRange,
    region,
}) {
    const response = await fetch('/api/search/ddg', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            time_range: timeRange || '',
            region: region || '',
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`DDG search request failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json();
    const results = normalizeSearchRows(payload?.results || []);
    return {
        provider: 'ddg',
        query: String(payload?.query || query || ''),
        result_count: Number(payload?.result_count || results.length),
        results,
    };
}

async function runSearchProvider(provider, options) {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider !== 'ddg') {
        throw new Error(`Unsupported provider: ${normalizedProvider}`);
    }
    return await runDdgSearch(options);
}

async function searchWeb(args = {}) {
    const settings = getSettings();
    const query = normalizeWhitespace(args?.query || '');
    if (!query) {
        throw new Error('query is required.');
    }

    const provider = normalizeProvider(args?.provider || settings.provider);
    const maxResults = clampInteger(
        args?.max_results ?? settings.defaultMaxResults,
        1,
        20,
        settings.defaultMaxResults,
    );
    const safeSearch = normalizeSafeSearch(args?.safe_search || settings.safeSearch);
    const timeRange = String(args?.time_range || '').trim().toLowerCase();
    const region = normalizeWhitespace(args?.region || '');

    return await runSearchProvider(provider, {
        query,
        maxResults,
        safeSearch,
        timeRange,
        region,
    });
}

async function visitWebPage(args = {}) {
    const settings = getSettings();
    const url = normalizeWhitespace(args?.url || '');
    if (!url) {
        throw new Error('url is required.');
    }

    const maxChars = clampInteger(
        args?.max_chars ?? settings.defaultVisitMaxChars,
        500,
        50000,
        settings.defaultVisitMaxChars,
    );

    const response = await fetch('/api/search/visit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url, html: true }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Visit request failed (${response.status}): ${text || response.statusText}`);
    }

    const html = await response.text();
    const parsed = htmlToReadableText(html);
    const fullText = normalizeWhitespace(parsed.text || fallbackStripHtml(html));
    const excerpt = fullText.slice(0, maxChars);

    return {
        url,
        title: parsed.title || '',
        text: excerpt,
        total_chars: fullText.length,
        truncated: fullText.length > excerpt.length,
    };
}

function installGlobalApi() {
    const root = globalThis;
    if (!root.Luker || typeof root.Luker !== 'object') {
        root.Luker = {};
    }
    root.Luker.searchTools = {
        search: searchWeb,
        visit: visitWebPage,
        getSettings: () => {
            const settings = getSettings();
            return {
                enabled: Boolean(settings.enabled),
                provider: String(settings.provider || 'ddg'),
                defaultMaxResults: Number(settings.defaultMaxResults || DEFAULT_SETTINGS.defaultMaxResults),
                defaultVisitMaxChars: Number(settings.defaultVisitMaxChars || DEFAULT_SETTINGS.defaultVisitMaxChars),
                safeSearch: String(settings.safeSearch || DEFAULT_SETTINGS.safeSearch),
            };
        },
    };
}

function registerTools(context) {
    Object.values(TOOL_NAMES).forEach(name => context.unregisterFunctionTool(name));

    context.registerFunctionTool({
        name: TOOL_NAMES.SEARCH,
        displayName: 'Web Search',
        description: 'Search the web for up-to-date information. Uses DuckDuckGo by default and does not require login.',
        // This only controls visibility to main model tool-calling.
        // Plugin API (Luker.searchTools.search/visit) remains available regardless.
        shouldRegister: async () => isToolEnabled(),
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query text.' },
                provider: { type: 'string', description: 'Search provider id. Default: ddg.' },
                max_results: { type: 'integer', description: 'Maximum number of search results (1-20).' },
                safe_search: { type: 'string', enum: ['off', 'moderate', 'strict'] },
                time_range: { type: 'string', enum: ['', 'day', 'week', 'month', 'year'] },
                region: { type: 'string', description: 'Optional DuckDuckGo region code (kl), e.g. us-en.' },
            },
            required: ['query'],
            additionalProperties: false,
        },
        action: async (args) => {
            return await searchWeb(args);
        },
        formatMessage: () => 'Searching web...',
    });

    context.registerFunctionTool({
        name: TOOL_NAMES.VISIT,
        displayName: 'Visit Web Page',
        description: 'Fetch one webpage and return readable text excerpt.',
        // This only controls visibility to main model tool-calling.
        // Plugin API (Luker.searchTools.search/visit) remains available regardless.
        shouldRegister: async () => isToolEnabled(),
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'HTTP/HTTPS page URL.' },
                max_chars: { type: 'integer', description: 'Maximum output characters (500-50000).' },
            },
            required: ['url'],
            additionalProperties: false,
        },
        action: async (args) => {
            return await visitWebPage(args);
        },
        formatMessage: () => 'Fetching webpage...',
    });
}

function renderSettingsBlock() {
    return `
<div id="${UI_BLOCK_ID}" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>${escapeHtml(i18n('Search Tools'))}</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <label class="checkbox_label">
            <input id="search_tools_enabled" type="checkbox" />
            ${escapeHtml(i18n('Expose tools to main model'))}
        </label>
        <label for="search_tools_provider">${escapeHtml(i18n('Search provider'))}</label>
        <select id="search_tools_provider" class="text_pole">
            <option value="ddg">${escapeHtml(i18n('DuckDuckGo (no login)'))}</option>
        </select>
        <label for="search_tools_default_max_results">${escapeHtml(i18n('Default max search results'))}</label>
        <input id="search_tools_default_max_results" class="text_pole" type="number" min="1" max="20" step="1" />
        <label for="search_tools_safe_search">${escapeHtml(i18n('Default safe search'))}</label>
        <select id="search_tools_safe_search" class="text_pole">
            <option value="off">${escapeHtml(i18n('Off'))}</option>
            <option value="moderate">${escapeHtml(i18n('Moderate'))}</option>
            <option value="strict">${escapeHtml(i18n('Strict'))}</option>
        </select>
        <label for="search_tools_default_visit_max_chars">${escapeHtml(i18n('Default page excerpt max chars'))}</label>
        <input id="search_tools_default_visit_max_chars" class="text_pole" type="number" min="500" max="50000" step="100" />
    </div>
</div>`;
}

function bindSettingsUi() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    const settings = getSettings();
    root.find('#search_tools_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#search_tools_provider').val(String(settings.provider || 'ddg'));
    root.find('#search_tools_default_max_results').val(String(settings.defaultMaxResults));
    root.find('#search_tools_default_visit_max_chars').val(String(settings.defaultVisitMaxChars));
    root.find('#search_tools_safe_search').val(String(settings.safeSearch || 'moderate'));

    root.off('.searchTools');
    root.on('input.searchTools', '#search_tools_enabled', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_provider', function () {
        settings.provider = normalizeProvider(jQuery(this).val());
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_default_max_results', function () {
        settings.defaultMaxResults = clampInteger(jQuery(this).val(), 1, 20, DEFAULT_SETTINGS.defaultMaxResults);
        jQuery(this).val(String(settings.defaultMaxResults));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_default_visit_max_chars', function () {
        settings.defaultVisitMaxChars = clampInteger(jQuery(this).val(), 500, 50000, DEFAULT_SETTINGS.defaultVisitMaxChars);
        jQuery(this).val(String(settings.defaultVisitMaxChars));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_safe_search', function () {
        settings.safeSearch = normalizeSafeSearch(jQuery(this).val());
        saveSettingsDebounced();
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    if (!jQuery(`#${UI_BLOCK_ID}`).length) {
        host.append(renderSettingsBlock());
    }
    bindSettingsUi();
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Search Tools': '搜索工具',
        'Expose tools to main model': '暴露工具给主模型',
        'Search provider': '搜索提供方',
        'DuckDuckGo (no login)': 'DuckDuckGo（无需登录）',
        'Default max search results': '默认搜索结果上限',
        'Default safe search': '默认安全搜索',
        'Off': '关闭',
        'Moderate': '中等',
        'Strict': '严格',
        'Default page excerpt max chars': '默认网页摘录最大字符数',
    });

    addLocaleData('zh-tw', {
        'Search Tools': '搜尋工具',
        'Expose tools to main model': '將工具暴露給主模型',
        'Search provider': '搜尋提供方',
        'DuckDuckGo (no login)': 'DuckDuckGo（無需登入）',
        'Default max search results': '預設搜尋結果上限',
        'Default safe search': '預設安全搜尋',
        'Off': '關閉',
        'Moderate': '中等',
        'Strict': '嚴格',
        'Default page excerpt max chars': '預設網頁摘錄最大字元數',
    });
}

jQuery(() => {
    ensureSettings();
    registerLocaleData();
    installGlobalApi();
    registerTools(getContext());
    ensureUi();
});
