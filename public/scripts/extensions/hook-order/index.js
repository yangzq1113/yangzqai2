import { saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';

const MODULE_NAME = 'hook_order';
const UI_BLOCK_ID = 'hook_order_settings';
const STYLE_ID = 'hook_order_style';

const TARGET_EVENTS = [
    { key: 'GENERATION_CONTEXT_READY', label: 'Generation Context Ready' },
    { key: 'GENERATION_BEFORE_WORLD_INFO_SCAN', label: 'Before World Info Scan' },
    { key: 'GENERATION_AFTER_WORLD_INFO_SCAN', label: 'After World Info Scan' },
    { key: 'GENERATION_WORLD_INFO_FINALIZED', label: 'World Info Finalized' },
    { key: 'GENERATION_BEFORE_API_REQUEST', label: 'Before API Request' },
];

const defaultSettings = {
    orderByEvent: {},
};

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message));
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function normalizeOrderList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of value) {
        const id = String(item || '').trim();
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        result.push(id);
    }
    return result;
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    if (!extension_settings[MODULE_NAME].orderByEvent || typeof extension_settings[MODULE_NAME].orderByEvent !== 'object') {
        extension_settings[MODULE_NAME].orderByEvent = {};
    }
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function getEventName(context, key) {
    return String(context.eventTypes?.[key] || '').trim();
}

function getEventOrderEntry(eventName) {
    const settings = getSettings();
    if (!settings.orderByEvent[eventName] || typeof settings.orderByEvent[eventName] !== 'object') {
        settings.orderByEvent[eventName] = { pluginOrder: [] };
    }
    settings.orderByEvent[eventName].pluginOrder = normalizeOrderList(settings.orderByEvent[eventName].pluginOrder);
    return settings.orderByEvent[eventName];
}

function getDiscoveredPluginsForEvent(context, eventName) {
    const meta = context.eventSource?.getListenersMeta?.(eventName);
    if (!Array.isArray(meta)) {
        return [];
    }
    const discovered = [];
    const seen = new Set();
    for (const item of meta) {
        const pluginId = String(item?.pluginId || '').trim();
        if (!pluginId || seen.has(pluginId)) {
            continue;
        }
        seen.add(pluginId);
        discovered.push(pluginId);
    }
    return discovered;
}

function getOrderedPluginList(context, eventName) {
    const entry = getEventOrderEntry(eventName);
    const ordered = normalizeOrderList(entry.pluginOrder);
    const discovered = getDiscoveredPluginsForEvent(context, eventName);

    const finalOrder = [];
    const seen = new Set();
    for (const pluginId of ordered) {
        if (!seen.has(pluginId)) {
            seen.add(pluginId);
            finalOrder.push(pluginId);
        }
    }
    for (const pluginId of discovered) {
        if (!seen.has(pluginId)) {
            seen.add(pluginId);
            finalOrder.push(pluginId);
        }
    }

    entry.pluginOrder = finalOrder;
    return finalOrder;
}

function applyOrderConfig(context) {
    const settings = getSettings();
    const config = {};
    for (const [eventName, value] of Object.entries(settings.orderByEvent)) {
        const pluginOrder = normalizeOrderList(value?.pluginOrder);
        if (pluginOrder.length > 0) {
            config[eventName] = { pluginOrder };
        }
    }

    globalThis.__stEventListenerOrderConfig = config;
    if (typeof context.eventSource?.setOrderConfig === 'function') {
        context.eventSource.setOrderConfig(config);
    }
}

function movePlugin(eventName, pluginId, direction) {
    const entry = getEventOrderEntry(eventName);
    const order = normalizeOrderList(entry.pluginOrder);
    const index = order.indexOf(pluginId);
    if (index < 0) {
        return false;
    }
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) {
        return false;
    }
    const [item] = order.splice(index, 1);
    order.splice(target, 0, item);
    entry.pluginOrder = order;
    return true;
}

function resetEventOrder(context, eventName) {
    const discovered = getDiscoveredPluginsForEvent(context, eventName);
    getEventOrderEntry(eventName).pluginOrder = discovered;
}

function renderEventCard(context, eventDef) {
    const eventName = getEventName(context, eventDef.key);
    if (!eventName) {
        return '';
    }
    const plugins = getOrderedPluginList(context, eventName);
    const rows = plugins.length > 0
        ? plugins.map((pluginId, index) => `
<div class="luker_hook_order_row" data-event-name="${escapeHtml(eventName)}" data-plugin-id="${escapeHtml(pluginId)}">
    <div class="luker_hook_order_plugin">${escapeHtml(pluginId)}</div>
    <div class="luker_hook_order_controls">
        <div class="menu_button" data-luker-action="move-up" ${index === 0 ? 'disabled' : ''}>Up</div>
        <div class="menu_button" data-luker-action="move-down" ${index === plugins.length - 1 ? 'disabled' : ''}>Down</div>
    </div>
</div>`)
            .join('')
        : '<div class="luker_hook_order_empty">No extension listeners detected for this hook.</div>';

    return `
<div class="luker_hook_order_card" data-event-name="${escapeHtml(eventName)}">
    <div class="luker_hook_order_title">${escapeHtml(eventDef.label)}</div>
    <small class="luker_hook_order_event">${escapeHtml(eventName)}</small>
    <div class="luker_hook_order_list">${rows}</div>
    <div class="flex-container">
        <div class="menu_button" data-luker-action="reset-event" data-event-name="${escapeHtml(eventName)}">Reset To Detected Order</div>
    </div>
</div>`;
}

function renderUi(root, context) {
    const cards = TARGET_EVENTS.map(eventDef => renderEventCard(context, eventDef)).join('');
    root.find('#luker_hook_order_list').html(cards);
}

function bindUi() {
    const context = getContext();
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    renderUi(root, context);
    root.off('.lukerHookOrder');

    root.on('click.lukerHookOrder', '[data-luker-action]', function () {
        const action = String(jQuery(this).data('luker-action') || '');
        const row = jQuery(this).closest('.luker_hook_order_row');
        const eventName = String(row.data('event-name') || jQuery(this).data('event-name') || '');
        const pluginId = String(row.data('plugin-id') || '');
        if (!eventName) {
            return;
        }

        if (action === 'move-up' || action === 'move-down') {
            const moved = movePlugin(eventName, pluginId, action === 'move-up' ? 'up' : 'down');
            if (moved) {
                applyOrderConfig(context);
                saveSettingsDebounced();
                bindUi();
            }
            return;
        }

        if (action === 'reset-event') {
            resetEventOrder(context, eventName);
            applyOrderConfig(context);
            saveSettingsDebounced();
            bindUi();
            return;
        }

        if (action === 'refresh') {
            bindUi();
            notifySuccess('Hook listener list refreshed.');
        }
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    if (!jQuery(`#${STYLE_ID}`).length) {
        jQuery('head').append(`
<style id="${STYLE_ID}">
#${UI_BLOCK_ID} .luker_hook_order_card {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.45));
    border-radius: 8px;
    padding: 8px;
    margin-bottom: 8px;
}
#${UI_BLOCK_ID} .luker_hook_order_title {
    font-weight: 600;
}
#${UI_BLOCK_ID} .luker_hook_order_event {
    opacity: 0.75;
}
#${UI_BLOCK_ID} .luker_hook_order_row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 6px;
    margin: 6px 0;
}
#${UI_BLOCK_ID} .luker_hook_order_plugin {
    word-break: break-all;
}
#${UI_BLOCK_ID} .luker_hook_order_controls {
    display: flex;
    gap: 6px;
}
#${UI_BLOCK_ID} .luker_hook_order_empty {
    opacity: 0.8;
    padding: 6px 0;
}
</style>`);
    }

    if (!jQuery(`#${UI_BLOCK_ID}`).length) {
        host.append(`
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Hook Order</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small style="opacity:0.85">Core event ordering for extension listeners. Reorder plugins per hook.</small>
            <div id="luker_hook_order_list" class="flex-container flexFlowColumn flexNoGap"></div>
            <div class="flex-container">
                <div class="menu_button" data-luker-action="refresh">Refresh Detected List</div>
            </div>
        </div>
    </div>
</div>`);
    }

    bindUi();
}

jQuery(() => {
    const context = getContext();
    ensureSettings();
    applyOrderConfig(context);
    saveSettingsDebounced();
    ensureUi();

    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        bindUi();
    });
});
