/**
 * CardApp Studio - AI-powered vibe coding editor for CardApp development.
 *
 * Layout: Left panel (AI chat) | Center (real chat/CardApp) | Right panel (code editor)
 */

import { getRequestHeaders } from '../../../../script.js';
import { reloadCardApp } from '../index.js';
import { sendAIMessage, TOOL_NAMES } from './ai-chat.js';

const MODULE_NAME = 'card-app/studio';
const STUDIO_PANEL_LEFT_ID = 'card-app-studio-left';
const STUDIO_PANEL_RIGHT_ID = 'card-app-studio-right';

let isStudioOpen = false;
let currentCharId = null;
let currentFile = null;
let fileList = [];

// AI chat state
let conversationMessages = [];
let isSending = false;
let activeAbortController = null;

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
 <span class="card-app-studio-title">🤖 AI Assistant</span>
 <button class="card-app-studio-close-btn" data-studio-action="close" title="Close Studio">✕</button>
 </div>
 <div class="card-app-studio-chat" data-studio-chat></div>
 <div class="card-app-studio-composer">
 <textarea class="card-app-studio-input" data-studio-input placeholder="Describe what you want to build..." rows="3"></textarea>
 <div class="card-app-studio-composer-buttons">
 <button class="card-app-studio-btn primary" data-studio-action="send">Send</button>
 <button class="card-app-studio-btn" data-studio-action="stop" disabled>Stop</button>
 </div>
 </div>
</div>`;
}

function buildRightPanelHtml() {
 return `
<div id="${STUDIO_PANEL_RIGHT_ID}" class="card-app-studio-panel right">
 <div class="card-app-studio-panel-header">
 <span class="card-app-studio-title">📝 Code Editor</span>
 <div class="card-app-studio-header-actions">
 <button class="card-app-studio-btn small" data-studio-action="save" title="Save (Ctrl+S)">💾 Save</button>
 <button class="card-app-studio-btn small" data-studio-action="reload" title="Reload CardApp">↻ Reload</button>
 </div>
 </div>
 <div class="card-app-studio-editor-area">
 <div class="card-app-studio-file-tabs" data-studio-tabs></div>
 <textarea class="card-app-studio-code" data-studio-code spellcheck="false" wrap="off"></textarea>
 </div>
 <div class="card-app-studio-file-tree">
 <div class="card-app-studio-file-tree-header">
 <span>📁 Files</span>
 <button class="card-app-studio-btn small" data-studio-action="new-file" title="New file">+</button>
 </div>
 <div class="card-app-studio-file-list" data-studio-file-list></div>
 </div>
</div>`;
}

function renderFileList(container) {
 const files = fileList.filter(f => f.type === 'file');
 container.innerHTML = files.length === 0
 ? '<div class="card-app-studio-empty">No files yet</div>'
 : files.map(f => `
 <div class="card-app-studio-file-item${currentFile === f.path ? ' active' : ''}" data-studio-file="${escapeHtml(f.path)}">
 <i class="${getFileIcon(f.path)}"></i>
 <span class="card-app-studio-file-name">${escapeHtml(f.path)}</span>
 <span class="card-app-studio-file-size">${f.size > 1024 ? (f.size / 1024).toFixed(1) + 'KB' : f.size + 'B'}</span>
 </div>
 `).join('');
}

async function openFile(filePath) {
 const codeArea = document.querySelector('[data-studio-code]');
 if (!codeArea || !currentCharId) return;

 try {
 const content = await fetchFileContent(currentCharId, filePath);
 codeArea.value = content;
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
 codeArea.value = `// Error loading ${filePath}: ${err.message}`;
 }
}

async function handleSaveCurrentFile() {
 const codeArea = document.querySelector('[data-studio-code]');
 if (!codeArea || !currentFile || !currentCharId) return;

 try {
 await saveFileContent(currentCharId, currentFile, codeArea.value);
 toastr.success(`Saved ${currentFile}`);
 await reloadCardApp();
 } catch (err) {
 console.error(`[${MODULE_NAME}] Failed to save file:`, err);
 toastr.error(`Failed to save: ${err.message}`);
 }
}

async function handleNewFile() {
 const name = prompt('New file name (e.g. utils.js):');
 if (!name || !currentCharId) return;

 const safeName = name.trim();
 if (!safeName) return;

 try {
 await saveFileContent(currentCharId, safeName, '');
 fileList = await fetchFileList(currentCharId);
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) renderFileList(fileListEl);
 await openFile(safeName);
 toastr.success(`Created ${safeName}`);
 } catch (err) {
 toastr.error(`Failed to create file: ${err.message}`);
 }
}

// ==================== Studio Lifecycle ====================

export async function openCardAppStudio(charId) {
 if (isStudioOpen) {
 toastr.warning('CardApp Studio is already open.');
 return;
 }

 currentCharId = charId;
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
 link.href = '/scripts/extensions/card-app/studio/studio.css';
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

 // Open first file
 const firstFile = fileList.find(f => f.type === 'file');
 if (firstFile) {
 await openFile(firstFile.path);
 }

 // Bind events
 bindStudioEvents();

 console.log(`[${MODULE_NAME}] Studio opened for ${charId}`);
}

export function closeCardAppStudio() {
 if (!isStudioOpen) return;

 // Remove panels
 document.getElementById(STUDIO_PANEL_LEFT_ID)?.remove();
 document.getElementById(STUDIO_PANEL_RIGHT_ID)?.remove();

 // Remove body class
 document.body.classList.remove('card-app-studio-active');

    isStudioOpen = false;
    currentCharId = null;
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

function renderChatMessage(role, content, toolInfo = null) {
    const chatEl = document.querySelector('[data-studio-chat]');
    if (!chatEl) return;
    const msgEl = document.createElement('div');
    msgEl.className = `card-app-studio-chat-msg ${role}`;
    if (toolInfo) {
        msgEl.innerHTML = `<div class="card-app-studio-tool-call">
            <span class="tool-icon">${toolInfo.ok ? '✅' : '❌'}</span>
            <span class="tool-name">${escapeHtml(toolInfo.name)}</span>
            <span class="tool-detail">${escapeHtml(toolInfo.detail)}</span>
        </div>`;
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
    msgEl.textContent = 'Thinking...';
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
        const result = await sendAIMessage(currentCharId, conversationMessages, userText, {
            abortSignal: controller.signal,
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
        renderChatMessage('assistant', err.message === 'Request aborted' ? '(Request cancelled)' : `Error: ${err.message}`);
    } finally {
        if (activeAbortController === controller) activeAbortController = null;
        isSending = false;
        syncComposerState();
    }
}

function handleAIStop() {
    if (activeAbortController && !activeAbortController.signal.aborted) {
        activeAbortController.abort();
        syncComposerState();
    }
}

function handleStudioClick(e) {
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

    // Escape: Close studio (only if not in textarea)
    if (e.key === 'Escape' && document.activeElement?.tagName !== 'TEXTAREA') {
        closeCardAppStudio();
        return;
    }
}

// Export file API for AI tool execution (Commit 4)
export { fetchFileList, fetchFileContent, saveFileContent, deleteFile, renameFile };
