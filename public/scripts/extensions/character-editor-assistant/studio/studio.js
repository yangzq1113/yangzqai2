/**
 * CardApp Studio - AI-powered vibe coding editor for CardApp development.
 *
 * Layout: Left panel (AI chat) | Center (real chat/CardApp) | Right panel (code editor)
 */

import { getRequestHeaders } from '../../../../script.js';
import { translate } from '../../../i18n.js';
import { DOMPurify, showdown } from '../../../../lib.js';
import { extension_settings, getContext, getExtensionApi, getCharacterState, setCharacterState } from '../../../extensions.js';
import { sendAIMessage, TOOL_NAMES } from './ai-chat.js';

// Markdown converter for AI messages
const mdConverter = new showdown.Converter({
    tables: true,
    strikethrough: true,
    ghCodeBlocks: true,
    tasklists: true,
    simpleLineBreaks: true,
    openLinksInNewWindow: true,
});

const MODULE_NAME = 'card-app/studio';

/** Reload CardApp via the core extension API. */
async function reloadCardApp() {
    const api = getExtensionApi('card-app');
    if (api?.reloadCardApp) await api.reloadCardApp();
}

function t(text) {
    return translate(String(text || ''));
}

function tFormat(text, ...values) {
    return t(text).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}
const STUDIO_PANEL_LEFT_ID = 'card-app-studio-left';
const STUDIO_PANEL_RIGHT_ID = 'card-app-studio-right';

let isStudioOpen = false;
let currentCharId = null;
let currentAvatar = null;
let currentFile = null;
let fileList = [];

// CodeMirror 6 state
let cmEditor = null;
let cmModules = null;
let cmLanguageCompartment = null;

// AI chat state
let conversationMessages = [];
let isSending = false;
let activeAbortController = null;

const SESSION_NAMESPACE = 'cardapp_studio_sessions';
const MAX_PERSISTED_MESSAGES = 100;

// ==================== Session Persistence (Character Sidecar) ====================

/**
 * Get the current character's avatar string for sidecar storage.
 * @returns {string} The avatar URL (e.g. 'xxx.png')
 */
function getCurrentAvatar() {
    if (currentAvatar) return currentAvatar;
    const context = getContext();
    const character = context.characters?.[context.characterId];
    return String(character?.avatar || '').trim();
}

async function loadSession() {
    const avatar = getCurrentAvatar();
    if (!avatar) return [];
    try {
        const data = await getCharacterState(avatar, SESSION_NAMESPACE);
        if (data && Array.isArray(data.messages)) {
            return data.messages.slice(-MAX_PERSISTED_MESSAGES);
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to load session from sidecar:`, err);
    }
    return [];
}

async function saveSession(messages) {
    const avatar = getCurrentAvatar();
    if (!avatar) return;
    try {
        await setCharacterState(avatar, SESSION_NAMESPACE, {
            messages: messages.slice(-MAX_PERSISTED_MESSAGES),
            updatedAt: Date.now(),
        });
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to save session to sidecar:`, err);
    }
}

async function clearSession() {
    const avatar = getCurrentAvatar();
    if (!avatar) return;
    try {
        await setCharacterState(avatar, SESSION_NAMESPACE, null);
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to clear session from sidecar:`, err);
    }
}

// ==================== File API ====================

async function fetchFileList(charId) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/files`, {
 headers: getRequestHeaders(),
 });
 if (!response.ok) throw new Error(`Failed to list files: ${response.status}`);
 const data = await response.json();
 return data.files || [];
}

async function fetchFileContent(charId, filePath) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
 headers: getRequestHeaders(),
 });
 if (!response.ok) throw new Error(`Failed to read file: ${response.status}`);
 return await response.text();
}

async function saveFileContent(charId, filePath, content) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
 method: 'PUT',
 headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
 body: JSON.stringify({ content }),
 });
 if (!response.ok) throw new Error(`Failed to save file: ${response.status}`);
 return await response.json();
}

async function deleteFile(charId, filePath) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
 method: 'DELETE',
 headers: getRequestHeaders(),
 });
 if (!response.ok) throw new Error(`Failed to delete file: ${response.status}`);
 return await response.json();
}

async function renameFile(charId, fromPath, toPath) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/rename`, {
 method: 'POST',
 headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
 body: JSON.stringify({ from: fromPath, to: toPath }),
 });
 if (!response.ok) throw new Error(`Failed to rename file: ${response.status}`);
 return await response.json();
}

// ==================== Skeleton Init ====================

async function ensureSkeletonFiles(charId) {
 const files = await fetchFileList(charId);
 if (files.length === 0) {
 await saveFileContent(charId, 'index.js', `/**\n * CardApp entry point.\n * @param {object} ctx - The CardApp context object\n */\nexport function init(ctx) {\n ctx.container.innerHTML = '<div style="padding:20px;">Hello from CardApp!</div>';\n}\n`);
 await saveFileContent(charId, 'style.css', '/* CardApp styles */\n');
 console.log(`[${MODULE_NAME}] Created skeleton files for ${charId}`);
 }
}

// ==================== CodeMirror 6 ====================

/**
 * Lazily load the CodeMirror 6 bundle.
 * @returns {Promise<object>} The CM6 module exports
 */
async function loadCM6() {
    if (cmModules) return cmModules;
    cmModules = await import('/codemirror.bundle.js');
    return cmModules;
}

/**
 * Get the CM6 language extension for a file path.
 * @param {string} filePath
 * @returns {object} CM6 language extension
 */
function getLanguageForFile(filePath) {
    if (!cmModules) return [];
    const ext = (filePath || '').split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'js': case 'mjs': case 'jsx': case 'ts': case 'tsx':
            return cmModules.javascript({ jsx: ext === 'jsx' || ext === 'tsx', typescript: ext === 'ts' || ext === 'tsx' });
        case 'css':
            return cmModules.css();
        case 'html': case 'htm': case 'svg':
            return cmModules.html();
        case 'json':
            return cmModules.json();
        case 'md': case 'markdown':
            return cmModules.markdown();
        default:
            return [];
    }
}

/**
 * Create a CM6 editor instance in the given container.
 * @param {HTMLElement} container
 * @param {string} content
 * @param {string} filePath
 */
async function createCMEditor(container, content = '', filePath = '') {
    const cm = await loadCM6();
    cmLanguageCompartment = new cm.Compartment();

    const lukerTheme = cm.EditorView.theme({
        '&': {
            height: '100%',
            fontSize: '13px',
        },
        '.cm-scroller': {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            overflow: 'auto',
        },
        '.cm-gutters': {
            borderRight: '1px solid var(--SmartThemeBorderColor, #333)',
            backgroundColor: 'color-mix(in oklab, var(--SmartThemeBlurTintColor, #1e1e1e) 90%, transparent)',
        },
        '.cm-activeLineGutter': {
            backgroundColor: 'color-mix(in oklab, var(--SmartThemeBodyColor, #fff) 12%, transparent)',
        },
        '.cm-activeLine': {
            backgroundColor: 'color-mix(in oklab, var(--SmartThemeBodyColor, #fff) 6%, transparent)',
        },
        '.cm-selectionBackground': {
            backgroundColor: 'color-mix(in oklab, var(--SmartThemeBodyColor, #fff) 18%, transparent) !important',
        },
        '&.cm-focused .cm-cursor': {
            borderLeftColor: 'var(--SmartThemeBodyColor, #fff)',
        },
    }, { dark: true });

    const extensions = [
        cm.lineNumbers(),
        cm.highlightActiveLineGutter(),
        cm.highlightSpecialChars(),
        cm.history(),
        cm.foldGutter(),
        cm.drawSelection(),
        cm.dropCursor(),
        cm.EditorState.allowMultipleSelections.of(true),
        cm.indentOnInput(),
        cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
        cm.bracketMatching(),
        cm.closeBrackets(),
        cm.autocompletion(),
        cm.rectangularSelection(),
        cm.crosshairCursor(),
        cm.highlightActiveLine(),
        cm.highlightSelectionMatches(),
        cm.keymap.of([
            ...cm.closeBracketsKeymap,
            ...cm.defaultKeymap,
            ...cm.searchKeymap,
            ...cm.historyKeymap,
            ...cm.foldKeymap,
            ...cm.completionKeymap,
            ...cm.lintKeymap,
            cm.indentWithTab,
        ]),
        cmLanguageCompartment.of(getLanguageForFile(filePath)),
        cm.oneDark,
        lukerTheme,
        cm.EditorView.lineWrapping,
    ];

    cmEditor = new cm.EditorView({
        state: cm.EditorState.create({
            doc: content,
            extensions,
        }),
        parent: container,
    });
}

/**
 * Set the content of the CM6 editor.
 * @param {string} content
 * @param {string} [filePath]
 */
function setCMContent(content, filePath = '') {
    if (!cmEditor) return;
    cmEditor.dispatch({
        changes: { from: 0, to: cmEditor.state.doc.length, insert: content },
    });
    // Update language mode if file changed
    if (cmLanguageCompartment && cmModules) {
        cmEditor.dispatch({
            effects: cmLanguageCompartment.reconfigure(getLanguageForFile(filePath)),
        });
    }
}

/**
 * Get the current content from the CM6 editor.
 * @returns {string}
 */
function getCMContent() {
    if (!cmEditor) return '';
    return cmEditor.state.doc.toString();
}

/**
 * Destroy the CM6 editor instance.
 */
function destroyCMEditor() {
    if (cmEditor) {
        cmEditor.destroy();
        cmEditor = null;
    }
    cmLanguageCompartment = null;
}

// ==================== UI ====================

function escapeHtml(str) {
 const div = document.createElement('div');
 div.textContent = str;
 return div.innerHTML;
}

function getFileIcon(filePath) {
 const ext = filePath.split('.').pop()?.toLowerCase();
 const icons = {
 js: 'fa-brands fa-js',
 css: 'fa-brands fa-css3-alt',
 html: 'fa-brands fa-html5',
 json: 'fa-solid fa-brackets-curly',
 md: 'fa-solid fa-file-lines',
 png: 'fa-solid fa-image',
 jpg: 'fa-solid fa-image',
 svg: 'fa-solid fa-image',
 };
 return icons[ext] || 'fa-solid fa-file';
}

function buildLeftPanelHtml() {
 return `
<div id="${STUDIO_PANEL_LEFT_ID}" class="card-app-studio-panel left">
 <div class="card-app-studio-panel-header">
    <span class="card-app-studio-title">🤖 ${escapeHtml(t('AI Assistant'))}</span>
    <button class="card-app-studio-btn small" data-studio-action="clear-chat" title="${escapeHtml(t('Clear chat'))}">🗑</button>
    <button class="card-app-studio-close-btn" data-studio-action="close" title="${escapeHtml(t('Close Studio'))}">✕</button>
 </div>
 <div class="card-app-studio-chat" data-studio-chat></div>
 <div class="card-app-studio-composer">
    <textarea class="card-app-studio-input" data-studio-input placeholder="${escapeHtml(t('Describe what you want to build...'))}" rows="3"></textarea>
 <div class="card-app-studio-composer-buttons">
        <button class="card-app-studio-btn primary" data-studio-action="send">${escapeHtml(t('Send'))}</button>
        <button class="card-app-studio-btn" data-studio-action="stop" disabled>${escapeHtml(t('Stop'))}</button>
 </div>
 </div>
</div>`;
}

function buildRightPanelHtml() {
 return `
<div id="${STUDIO_PANEL_RIGHT_ID}" class="card-app-studio-panel right">
 <div class="card-app-studio-panel-header">
    <span class="card-app-studio-title">📝 ${escapeHtml(t('Code Editor'))}</span>
 <div class="card-app-studio-header-actions">
        <button class="card-app-studio-btn small" data-studio-action="save" title="${escapeHtml(t('Save'))} (Ctrl+S)">💾 ${escapeHtml(t('Save'))}</button>
        <button class="card-app-studio-btn small" data-studio-action="reload" title="${escapeHtml(t('Reload'))}">↻ ${escapeHtml(t('Reload'))}</button>
 </div>
 </div>
 <div class="card-app-studio-editor-area">
 <div class="card-app-studio-file-tabs" data-studio-tabs></div>
 <div class="card-app-studio-code" data-studio-code></div>
 </div>
 <div class="card-app-studio-file-tree">
 <div class="card-app-studio-file-tree-header">
        <span>📁 ${escapeHtml(t('Files'))}</span>
 <button class="card-app-studio-btn small" data-studio-action="new-file" title="New file">+</button>
 </div>
 <div class="card-app-studio-file-list" data-studio-file-list></div>
 </div>
 <div class="card-app-studio-history">
 <div class="card-app-studio-file-tree-header">
        <span>📜 ${escapeHtml(t('History'))}</span>
 <button class="card-app-studio-btn small" data-studio-action="refresh-history" title="${escapeHtml(t('Refresh'))}">↻</button>
 </div>
 <div class="card-app-studio-history-list" data-studio-history></div>
 </div>
</div>`;
}

function renderFileList(container) {
 const files = fileList.filter(f => f.type === 'file');
 container.innerHTML = files.length === 0
        ? `<div class="card-app-studio-empty">${escapeHtml(t('No files yet'))}</div>`
 : files.map(f => `
 <div class="card-app-studio-file-item${currentFile === f.path ? ' active' : ''}" data-studio-file="${escapeHtml(f.path)}">
 <i class="${getFileIcon(f.path)}"></i>
 <span class="card-app-studio-file-name">${escapeHtml(f.path)}</span>
 <span class="card-app-studio-file-size">${f.size > 1024 ? (f.size / 1024).toFixed(1) + 'KB' : f.size + 'B'}</span>
 </div>
 `).join('');
}

async function fetchHistory(charId) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/history`, {
        headers: getRequestHeaders(),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.commits || [];
}

async function rollbackToCommit(charId, hash) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/rollback`, {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
    });
    if (!response.ok) throw new Error(`Rollback failed: ${response.status}`);
    return await response.json();
}

async function renderHistory() {
    const historyEl = document.querySelector('[data-studio-history]');
    if (!historyEl || !currentCharId) return;

    historyEl.innerHTML = `<div class="card-app-studio-empty">${escapeHtml(t('Loading...'))}</div>`;

    try {
        const commits = await fetchHistory(currentCharId);
        if (commits.length === 0) {
            historyEl.innerHTML = `<div class="card-app-studio-empty">${escapeHtml(t('No history yet'))}</div>`;
            return;
        }
        historyEl.innerHTML = commits.map(c => {
            const timeAgo = formatTimeAgo(c.date);
            return `
            <div class="card-app-studio-history-item" data-studio-commit="${escapeHtml(c.fullHash)}">
                <div class="card-app-studio-history-info">
                    <span class="card-app-studio-history-hash">${escapeHtml(c.hash)}</span>
                    <span class="card-app-studio-history-msg">${escapeHtml(c.message)}</span>
                </div>
                <div class="card-app-studio-history-meta">
                    <span class="card-app-studio-history-time">${escapeHtml(timeAgo)}</span>
                    <button class="card-app-studio-btn small" data-studio-action="rollback" data-studio-hash="${escapeHtml(c.fullHash)}">↩</button>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        historyEl.innerHTML = `<div class="card-app-studio-empty">${escapeHtml(tFormat('Error: ${0}', err.message))}</div>`;
    }
}

function formatTimeAgo(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

async function handleRollback(hash) {
    if (!currentCharId || !hash) return;
    if (!confirm(t('Rollback to this version? This cannot be undone.'))) return;

    try {
        await rollbackToCommit(currentCharId, hash);
        toastr.success(t('Rolled back successfully'));

        // Refresh everything
        fileList = await fetchFileList(currentCharId);
        const fileListEl = document.querySelector('[data-studio-file-list]');
        if (fileListEl) renderFileList(fileListEl);
        if (currentFile) await openFile(currentFile);
        await renderHistory();
        await reloadCardApp();
    } catch (err) {
        toastr.error(tFormat('Rollback failed: ${0}', err.message));
    }
}

async function openFile(filePath) {
 if (!currentCharId) return;

 try {
 const content = await fetchFileContent(currentCharId, filePath);
 setCMContent(content, filePath);
 currentFile = filePath;

 // Update file list highlight
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) renderFileList(fileListEl);

 // Update tab display
 const tabsEl = document.querySelector('[data-studio-tabs]');
 if (tabsEl) {
 tabsEl.innerHTML = `<div class="card-app-studio-tab active">${escapeHtml(filePath)}</div>`;
 }
 } catch (err) {
 console.error(`[${MODULE_NAME}] Failed to open file:`, err);
 setCMContent(`// Error loading ${filePath}: ${err.message}`, filePath);
 }
}

async function handleSaveCurrentFile() {
 if (!currentFile || !currentCharId) return;

 try {
 await saveFileContent(currentCharId, currentFile, getCMContent());
        toastr.success(tFormat('Saved ${0}', currentFile));
 await reloadCardApp();
 } catch (err) {
 console.error(`[${MODULE_NAME}] Failed to save file:`, err);
        toastr.error(tFormat('Failed to save: ${0}', err.message));
 }
}

async function handleNewFile() {
    const name = prompt(t('New file name (e.g. utils.js):'));
 if (!name || !currentCharId) return;

 const safeName = name.trim();
 if (!safeName) return;

 try {
 await saveFileContent(currentCharId, safeName, '');
 fileList = await fetchFileList(currentCharId);
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) renderFileList(fileListEl);
 await openFile(safeName);
        toastr.success(tFormat('Created ${0}', safeName));
 } catch (err) {
        toastr.error(tFormat('Failed to create file: ${0}', err.message));
 }
}

// ==================== Studio Lifecycle ====================

export async function openCardAppStudio(charId) {
 if (isStudioOpen) {
        toastr.warning(t('CardApp Studio is already open.'));
 return;
 }

 currentCharId = charId;
 // Cache the full avatar string for sidecar session storage
 const context = getContext();
 const character = context.characters?.[context.characterId];
 currentAvatar = String(character?.avatar || '').trim();
 isStudioOpen = true;

 // Ensure skeleton files exist
 await ensureSkeletonFiles(charId);

 // Load file list
 fileList = await fetchFileList(charId);

 // Inject CSS
 if (!document.getElementById('card-app-studio-style')) {
 const link = document.createElement('link');
 link.id = 'card-app-studio-style';
 link.rel = 'stylesheet';
 link.href = '/scripts/extensions/character-editor-assistant/studio/studio.css';
 document.head.appendChild(link);
 }

 // Create panels
 const leftPanel = document.createElement('div');
 leftPanel.innerHTML = buildLeftPanelHtml();
 document.body.appendChild(leftPanel.firstElementChild);

 const rightPanel = document.createElement('div');
 rightPanel.innerHTML = buildRightPanelHtml();
 document.body.appendChild(rightPanel.firstElementChild);

 // Add body class for margin adjustment
 document.body.classList.add('card-app-studio-active');

 // Render file list
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) renderFileList(fileListEl);

 // Initialize CodeMirror 6 editor
 const codeContainer = document.querySelector('[data-studio-code]');
 if (codeContainer) {
     await createCMEditor(codeContainer, '', '');
 }

 // Open first file
 const firstFile = fileList.find(f => f.type === 'file');
 if (firstFile) {
 await openFile(firstFile.path);
 }

 // Load persisted conversation
 conversationMessages = await loadSession();

 // Render persisted messages in chat
 const chatEl = document.querySelector('[data-studio-chat]');
 if (chatEl && conversationMessages.length > 0) {
     for (const msg of conversationMessages) {
         if (msg.role === 'user') {
             renderChatMessage('user', msg.content);
         } else if (msg.role === 'assistant' && msg.content) {
             renderChatMessage('assistant', msg.content);
         }
     }
 }

 // Load history
 renderHistory();

 // Bind events
 bindStudioEvents();

 console.log(`[${MODULE_NAME}] Studio opened for ${charId}`);
}

export async function closeCardAppStudio() {
 if (!isStudioOpen) return;

 // Destroy CM6 editor
 destroyCMEditor();

 // Remove panels
 document.getElementById(STUDIO_PANEL_LEFT_ID)?.remove();
 document.getElementById(STUDIO_PANEL_RIGHT_ID)?.remove();

 // Remove body class
 document.body.classList.remove('card-app-studio-active');

    // Save conversation before clearing state
    if (currentCharId && conversationMessages.length > 0) {
        await saveSession(conversationMessages);
    }
    isStudioOpen = false;
    currentCharId = null;
    currentAvatar = null;
    currentFile = null;
    fileList = [];
    conversationMessages = [];
    isSending = false;
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }
    document.removeEventListener('click', handleStudioClick);
    document.removeEventListener('keydown', handleStudioKeydown);

    console.log(`[${MODULE_NAME}] Studio closed`);
}

function bindStudioEvents() {
 // Delegated click handler for both panels
 document.addEventListener('click', handleStudioClick);

 // Keyboard shortcuts
 document.addEventListener('keydown', handleStudioKeydown);

 // File list click
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) {
 fileListEl.addEventListener('click', async (e) => {
 const fileItem = e.target.closest('[data-studio-file]');
 if (fileItem) {
 const filePath = fileItem.dataset.studioFile;
 if (filePath) await openFile(filePath);
 }
 });
 }
}

// ==================== AI Chat UI ====================

/**
 * Render markdown content to sanitized HTML.
 * @param {string} text
 * @returns {string}
 */
function renderMarkdown(text) {
    if (!text) return '';
    const html = mdConverter.makeHtml(text);
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/**
 * Get a human-readable label for a tool name.
 * @param {string} name
 * @returns {{ icon: string, label: string }}
 */
function getToolDisplay(name) {
    const map = {
        cardapp_list_files: { icon: '📂', label: 'List files' },
        cardapp_read_file: { icon: '📖', label: 'Read file' },
        cardapp_write_file: { icon: '✏️', label: 'Write file' },
        cardapp_patch_file: { icon: '🩹', label: 'Patch file' },
        cardapp_delete_file: { icon: '🗑️', label: 'Delete file' },
        cardapp_rename_file: { icon: '📝', label: 'Rename file' },
    };
    return map[name] || { icon: '🔧', label: name };
}

function renderChatMessage(role, content, toolInfo = null) {
    const chatEl = document.querySelector('[data-studio-chat]');
    if (!chatEl) return;
    const msgEl = document.createElement('div');
    msgEl.className = `card-app-studio-chat-msg ${role}`;
    if (toolInfo) {
        const display = getToolDisplay(toolInfo.name);
        msgEl.innerHTML = `<div class="card-app-studio-tool-call">
            <span class="tool-icon">${toolInfo.ok ? '✅' : '❌'}</span>
            <span class="tool-label">${escapeHtml(display.icon)} ${escapeHtml(display.label)}</span>
            ${toolInfo.detail ? `<span class="tool-detail">${escapeHtml(toolInfo.detail)}</span>` : ''}
        </div>`;
    } else if (role === 'assistant') {
        msgEl.innerHTML = `<div class="card-app-studio-msg-content">${renderMarkdown(content)}</div>`;
    } else if (role === 'user') {
        const pre = document.createElement('pre');
        pre.textContent = content;
        msgEl.appendChild(pre);
    } else {
        msgEl.textContent = content;
    }
    chatEl.appendChild(msgEl);
    chatEl.scrollTop = chatEl.scrollHeight;
}

function showLoadingMessage() {
    const chatEl = document.querySelector('[data-studio-chat]');
    if (!chatEl) return null;
    const msgEl = document.createElement('div');
    msgEl.className = 'card-app-studio-chat-msg assistant loading';
    msgEl.innerHTML = `<div class="card-app-studio-loading-dots">
        <span></span><span></span><span></span>
    </div>
    <span class="card-app-studio-loading-text">${escapeHtml(t('Thinking...'))}</span>`;
    chatEl.appendChild(msgEl);
    chatEl.scrollTop = chatEl.scrollHeight;
    return msgEl;
}

function syncComposerState() {
    const sendBtn = document.querySelector('[data-studio-action="send"]');
    const stopBtn = document.querySelector('[data-studio-action="stop"]');
    const input = document.querySelector('[data-studio-input]');
    if (sendBtn) sendBtn.disabled = isSending;
    if (stopBtn) stopBtn.disabled = !isSending;
    if (input) input.disabled = isSending;
}

async function handleAISend() {
    const input = document.querySelector('[data-studio-input]');
    if (!input || !currentCharId) return;
    const userText = input.value.trim();
    if (!userText || isSending) return;
    input.value = '';
    isSending = true;
    const controller = new AbortController();
    activeAbortController = controller;
    syncComposerState();
    renderChatMessage('user', userText);
    const loadingEl = showLoadingMessage();
    try {
        // Read preset config from CEA settings
        const ceaSettings = extension_settings?.character_editor_assistant || {};
        const llmPresetName = String(ceaSettings.lorebookSyncLlmPresetName || '').trim();
        const apiPresetName = String(ceaSettings.lorebookSyncApiPresetName || '').trim();
        const result = await sendAIMessage(currentCharId, conversationMessages, userText, {
            abortSignal: controller.signal,
            llmPresetName,
            apiPresetName,
            onToolCall: (name, args, toolResult) => {
                let detail = '';
                if (name === TOOL_NAMES.READ_FILE) detail = args.path;
                else if (name === TOOL_NAMES.WRITE_FILE) detail = args.path;
                else if (name === TOOL_NAMES.PATCH_FILE) detail = args.path;
                else if (name === TOOL_NAMES.DELETE_FILE) detail = args.path;
                else if (name === TOOL_NAMES.RENAME_FILE) detail = `${args.from_path} → ${args.to_path}`;
                else if (name === TOOL_NAMES.LIST_FILES) detail = `${toolResult?.files?.length || 0} files`;
                renderChatMessage('tool', '', { name, detail, ok: toolResult.ok });
            },
        });
        if (loadingEl?.parentNode) loadingEl.remove();
        if (result.assistantText) renderChatMessage('assistant', result.assistantText);
        if (result.modifiedFiles.length > 0) {
            fileList = await fetchFileList(currentCharId);
            const fileListEl = document.querySelector('[data-studio-file-list]');
            if (fileListEl) renderFileList(fileListEl);
            if (currentFile && result.modifiedFiles.includes(currentFile)) await openFile(currentFile);
            await reloadCardApp();
        }
    } catch (err) {
        if (loadingEl?.parentNode) loadingEl.remove();
        renderChatMessage('assistant', err.message === 'Request aborted' ? t('(Request cancelled)') : tFormat('Error: ${0}', err.message));
    } finally {
        if (activeAbortController === controller) activeAbortController = null;
        isSending = false;
        syncComposerState();
        // Auto-save conversation
        if (currentCharId) await saveSession(conversationMessages);
    }
}

function handleAIStop() {
    if (activeAbortController && !activeAbortController.signal.aborted) {
        activeAbortController.abort();
        syncComposerState();
    }
}

async function handleStudioClick(e) {
    const actionEl = e.target.closest('[data-studio-action]');
    if (!actionEl) return;

    const action = actionEl.dataset.studioAction;
    switch (action) {
        case 'close':
            closeCardAppStudio();
            break;
        case 'save':
            handleSaveCurrentFile();
            break;
        case 'reload':
            reloadCardApp();
            break;
        case 'new-file':
            handleNewFile();
            break;
        case 'send':
            handleAISend();
            break;
        case 'stop':
            handleAIStop();
            break;
        case 'clear-chat': {
            conversationMessages = [];
            if (currentCharId) await clearSession();
            const chatEl = document.querySelector('[data-studio-chat]');
            if (chatEl) chatEl.innerHTML = '';
            break;
        }
        case 'refresh-history':
            renderHistory();
            break;
        case 'rollback': {
            const hash = actionEl.dataset.studioHash;
            if (hash) handleRollback(hash);
            break;
        }
    }
}

function handleStudioKeydown(e) {
    if (!isStudioOpen) return;

    // Ctrl+S: Save current file
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveCurrentFile();
        return;
    }

    // Enter in AI input: Send message (without Shift)
    const input = document.querySelector('[data-studio-input]');
    if (e.key === 'Enter' && !e.shiftKey && document.activeElement === input) {
        e.preventDefault();
        handleAISend();
        return;
    }

    // Escape: Close studio (only if not focused in AI input textarea or CM6 editor)
    if (e.key === 'Escape' && document.activeElement?.tagName !== 'TEXTAREA' && !document.activeElement?.closest('.cm-editor')) {
        closeCardAppStudio();
        return;
    }
}

// Export file API for AI tool execution (Commit 4)
export { fetchFileList, fetchFileContent, saveFileContent, deleteFile, renameFile };
