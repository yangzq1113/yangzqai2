import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { ensureImageFormatSupported, getBase64Async, humanFileSize } from './utils.js';

/**
 * @type {import('../../src/users.js').UserViewModel} Logged in user
 */
export let currentUser = null;
export let accountsEnabled = false;

// Extend the session every 10 minutes
const SESSION_EXTEND_INTERVAL = 10 * 60 * 1000;
const BACKUP_CATEGORY_KEYS = Object.freeze([
    'settings',
    'secrets',
    'characters',
    'chats',
    'lorebooks',
    'presets',
    'assets',
    'extensions',
    'vectors',
]);
const BACKUP_DEFAULT_SELECTION = Object.freeze({
    settings: true,
    secrets: true,
    characters: true,
    chats: true,
    lorebooks: true,
    presets: true,
    assets: true,
    extensions: true,
    vectors: false,
});
const BACKUP_FULL_SELECTION = Object.freeze(Object.fromEntries(BACKUP_CATEGORY_KEYS.map((key) => [key, true])));

/**
 * Enable or disable user account controls in the UI.
 * @param {boolean} isEnabled User account controls enabled
 * @returns {Promise<void>}
 */
export async function setUserControls(isEnabled) {
    accountsEnabled = isEnabled;

    if (!isEnabled) {
        $('#logout_button').hide();
        $('#admin_button').hide();
        $('#server_logs_button').show();
        return;
    }

    $('#logout_button').show();
    await getCurrentUser();
}

/**
 * Check if the current user is an admin.
 * @returns {boolean} True if the current user is an admin
 */
export function isAdmin() {
    if (!accountsEnabled) {
        return true;
    }

    if (!currentUser) {
        return false;
    }

    return Boolean(currentUser.admin);
}

/**
 * Gets the handle string of the current user.
 * @returns {string} User handle
 */
export function getCurrentUserHandle() {
    return currentUser?.handle || 'default-user';
}

/**
 * Get the current user.
 * @returns {Promise<void>}
 */
async function getCurrentUser() {
    try {
        const response = await fetch('/api/users/me', {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Failed to get current user');
        }

        currentUser = await response.json();
        $('#admin_button').toggle(accountsEnabled && isAdmin());
        $('#server_logs_button').toggle(!accountsEnabled || isAdmin());
    } catch (error) {
        console.error('Error getting current user:', error);
    }
}

/**
 * Get a list of all users.
 * @returns {Promise<import('../../src/users.js').UserViewModel[]>} Users
 */
async function getUsers() {
    try {
        const response = await fetch('/api/users/get', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error('Failed to get users');
        }

        return response.json();
    } catch (error) {
        console.error('Error getting users:', error);
    }
}

/**
 * Get an admin overview payload.
 * @returns {Promise<any>} Overview data
 */
async function getAdminOverview() {
    try {
        const response = await fetch('/api/users/overview', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error('Failed to get admin overview');
        }

        return response.json();
    } catch (error) {
        console.error('Error getting admin overview:', error);
    }
}

/**
 * Get global admin panel settings.
 * @returns {Promise<any>} Settings payload
 */
async function getAdminPanelSettings() {
    try {
        const response = await fetch('/api/users/settings/get', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error('Failed to get admin settings');
        }

        return response.json();
    } catch (error) {
        console.error('Error getting admin settings:', error);
    }
}

/**
 * Save global admin panel settings.
 * @param {any} payload Settings payload
 * @returns {Promise<any>} Saved settings
 */
async function saveAdminPanelSettings(payload) {
    try {
        const response = await fetch('/api/users/settings/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data?.error || 'Unknown error', 'Failed to save admin settings');
            throw new Error('Failed to save admin settings');
        }

        return response.json();
    } catch (error) {
        console.error('Error saving admin settings:', error);
    }
}

/**
 * Set per-user storage quota.
 * @param {string} handle User handle
 * @param {number|null} quotaBytes Quota bytes, null to clear override
 * @param {() => void} callback Callback on success
 */
async function setUserQuota(handle, quotaBytes, callback) {
    try {
        const response = await fetch('/api/users/set-quota', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, storageQuotaBytes: quotaBytes }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data?.error || 'Unknown error', 'Failed to set user quota');
            throw new Error('Failed to set user quota');
        }

        callback();
    } catch (error) {
        console.error('Error setting user quota:', error);
    }
}

/**
 * Enable a user account.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function enableUser(handle, callback) {
    try {
        const response = await fetch('/api/users/enable', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to enable user');
            throw new Error('Failed to enable user');
        }

        callback();
    } catch (error) {
        console.error('Error enabling user:', error);
    }
}

async function disableUser(handle, callback) {
    try {
        const response = await fetch('/api/users/disable', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data?.error || 'Unknown error', 'Failed to disable user');
            throw new Error('Failed to disable user');
        }

        callback();
    } catch (error) {
        console.error('Error disabling user:', error);
    }
}

/**
 * Promote a user to admin.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function promoteUser(handle, callback) {
    try {
        const response = await fetch('/api/users/promote', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to promote user');
            throw new Error('Failed to promote user');
        }

        callback();
    } catch (error) {
        console.error('Error promoting user:', error);
    }
}

/**
 * Demote a user from admin.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function demoteUser(handle, callback) {
    try {
        const response = await fetch('/api/users/demote', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to demote user');
            throw new Error('Failed to demote user');
        }

        callback();
    } catch (error) {
        console.error('Error demoting user:', error);
    }
}

/**
 * Create a new user.
 * @param {HTMLFormElement} form Form element
 */
async function createUser(form, callback) {
    const errors = [];
    const formData = new FormData(form);

    if (!formData.get('handle')) {
        errors.push('Handle is required');
    }

    if (formData.get('password') !== formData.get('confirm')) {
        errors.push('Passwords do not match');
    }

    if (errors.length) {
        toastr.error(errors.join(', '), 'Failed to create user');
        return;
    }

    const body = {};
    formData.forEach(function (value, key) {
        if (key === 'confirm') {
            return;
        }
        if (key.startsWith('_')) {
            key = key.substring(1);
        }
        body[key] = value;
    });

    try {
        const response = await fetch('/api/users/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to create user');
            throw new Error('Failed to create user');
        }

        form.reset();
        callback();
    } catch (error) {
        console.error('Error creating user:', error);
    }
}

/**
 * Backup a user's data.
 * @param {string} handle Handle of the user to backup
 * @param {function} callback Success callback
 * @param {Record<string, boolean>} [selection] Backup category selection
 * @returns {Promise<void>}
 */
async function backupUserData(handle, callback, selection = BACKUP_DEFAULT_SELECTION) {
    let progressToast;
    try {
        progressToast = toastr.info(
            t`Please wait for the download to start.`,
            t`Backup Requested`,
            { timeOut: 0, extendedTimeOut: 0, closeButton: false, tapToDismiss: false },
        );
        const response = await fetch('/api/users/backup', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, selection }),
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            toastr.error(data.error || t`Unknown error`, t`Failed to backup user data`);
            throw new Error('Failed to backup user data');
        }

        const blob = await response.blob();
        const header = response.headers.get('Content-Disposition') || '';
        const fileNameMatch = /filename="?([^"]+)"?/i.exec(header);
        const filename = fileNameMatch?.[1] || `${handle}-backup.zip`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        callback?.();
    } catch (error) {
        console.error('Error backing up user data:', error);
    } finally {
        if (progressToast) {
            toastr.clear(progressToast);
        }
    }
}

function collectBackupSelection(rootElement) {
    const selection = { ...BACKUP_DEFAULT_SELECTION };

    BACKUP_CATEGORY_KEYS.forEach((key) => {
        const checkbox = rootElement.find(`input[name="backupCategory"][value="${key}"]`);
        if (checkbox.length > 0) {
            selection[key] = checkbox.is(':checked');
        }
    });

    return selection;
}

function getSelectedRestoreMode(rootElement) {
    const selected = rootElement.find('input[name="backupRestoreMode"]:checked').val();
    return String(selected || 'merge') === 'overwrite' ? 'overwrite' : 'merge';
}

async function restoreUserData(handle, file, selection, mode, callback) {
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('handle', handle);
    formData.append('mode', mode);
    formData.append('selection', JSON.stringify(selection));

    const response = await fetch('/api/users/restore-backup', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to restore backup');
    }

    const data = await response.json();
    callback?.(data);
    return data;
}

async function openBackupManager(handle, callback) {
    const template = $(await renderTemplateAsync('userBackupManager'));
    const fileInput = template.find('.backupRestoreFileInput');
    const selectedFileText = template.find('.backupSelectedFileName');
    const restoreButton = template.find('.backupRestoreButton');
    const restoreSelectButton = template.find('.backupRestoreSelectButton');
    const importDataButton = template.find('.backupImportDataButton');
    const downloadButton = template.find('.backupDownloadButton');
    const checkboxes = template.find('input[name="backupCategory"]');
    const summaryText = template.find('.backupCategorySummary');

    const updateSelectionSummary = () => {
        const selectedCount = checkboxes.filter(':checked').length;
        summaryText.text(t`Selected ${selectedCount} of ${BACKUP_CATEGORY_KEYS.length} categories`);
    };

    const setSelection = (selection) => {
        BACKUP_CATEGORY_KEYS.forEach((key) => {
            const checkbox = template.find(`input[name="backupCategory"][value="${key}"]`);
            checkbox.prop('checked', Boolean(selection[key]));
        });
        updateSelectionSummary();
    };

    const updateRestoreState = () => {
        const hasFile = Boolean(fileInput[0]?.files?.[0]);
        restoreButton.toggleClass('disabled', !hasFile);
        importDataButton.toggleClass('disabled', !hasFile);
    };

    const runRestore = async (file, selectionOverride = null) => {
        if (!file) {
            return;
        }

        const selection = selectionOverride ?? collectBackupSelection(template);
        if (!Object.values(selection).some(Boolean)) {
            toastr.warning(t`Select at least one data category.`, t`Nothing selected`);
            return;
        }

        const mode = getSelectedRestoreMode(template);
        const confirmationMessage = mode === 'overwrite'
            ? t`Overwrite mode will clear existing selected data before restore. Continue?`
            : t`Restore in merge mode and overwrite files on path conflicts?`;

        const confirm = await callGenericPopup(confirmationMessage, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Start Restore`,
            cancelButton: t`Cancel`,
            wide: false,
            large: false,
        });

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        let progressToast;
        try {
            progressToast = toastr.info(
                t`Please wait...`,
                t`Backup and Restore`,
                { timeOut: 0, extendedTimeOut: 0, closeButton: false, tapToDismiss: false },
            );
            restoreButton.addClass('disabled');
            restoreSelectButton.addClass('disabled');
            importDataButton.addClass('disabled');
            downloadButton.addClass('disabled');
            const result = await restoreUserData(handle, file, selection, mode);
            toastr.success(
                t`Restored ${result.restoredCount} files. Skipped ${result.skippedCount}, rejected ${result.rejectedCount}.`,
                t`Backup Restored`,
            );
            callback?.(result);
        } catch (error) {
            console.error('Error restoring user data:', error);
            toastr.error(String(error.message || error), t`Failed to restore backup`);
        } finally {
            if (progressToast) {
                toastr.clear(progressToast);
            }
            restoreButton.removeClass('disabled');
            restoreSelectButton.removeClass('disabled');
            importDataButton.removeClass('disabled');
            downloadButton.removeClass('disabled');
            fileInput.val('');
            selectedFileText.text(t`No ZIP selected.`);
            updateRestoreState();
        }
    };

    template.find('.backupSelectAllButton').on('click', function () {
        setSelection(Object.fromEntries(BACKUP_CATEGORY_KEYS.map((key) => [key, true])));
    });

    template.find('.backupSelectRecommendedButton').on('click', function () {
        setSelection(BACKUP_DEFAULT_SELECTION);
    });

    template.find('.backupSelectNoneButton').on('click', function () {
        setSelection(Object.fromEntries(BACKUP_CATEGORY_KEYS.map((key) => [key, false])));
    });

    checkboxes.on('change', updateSelectionSummary);
    updateSelectionSummary();

    downloadButton.on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        const selection = collectBackupSelection(template);
        if (!Object.values(selection).some(Boolean)) {
            toastr.warning(t`Select at least one data category.`, t`Nothing selected`);
            return;
        }

        $(this).addClass('disabled');
        restoreSelectButton.addClass('disabled');
        restoreButton.addClass('disabled');
        importDataButton.addClass('disabled');

        try {
            await backupUserData(handle, () => { }, selection);
        } finally {
            $(this).removeClass('disabled');
            restoreSelectButton.removeClass('disabled');
            importDataButton.removeClass('disabled');
            updateRestoreState();
        }
    });

    restoreSelectButton.on('click', function () {
        if ($(this).hasClass('disabled')) {
            return;
        }
        fileInput.trigger('click');
    });

    restoreButton.on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }
        const file = fileInput[0]?.files?.[0];
        await runRestore(file);
    });

    importDataButton.on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        const file = fileInput[0]?.files?.[0];
        await runRestore(file, BACKUP_FULL_SELECTION);
    });

    fileInput.on('change', function () {
        const file = this instanceof HTMLInputElement ? this.files?.[0] : null;
        selectedFileText.text(file ? t`${file.name} (${humanFileSize(file.size)})` : t`No ZIP selected.`);
        updateRestoreState();
    });

    updateRestoreState();

    await callGenericPopup(template, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        wide: true,
        large: false,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
    });
}

async function fetchServerLogs(limit = 1000, sinceId = 0) {
    const response = await fetch('/api/users/logs/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ limit, sinceId }),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch server logs');
    }

    return response.json();
}

async function clearServerLogsRemote() {
    const response = await fetch('/api/users/logs/clear', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to clear server logs');
    }
}

function formatServerLogEntry(entry) {
    const date = new Date(Number(entry?.timestamp) || Date.now());
    const level = String(entry?.level || 'log').toUpperCase();
    const message = String(entry?.message || '');
    return `[${date.toLocaleString()}] [${level}] ${message}`;
}

async function openServerLogsViewer() {
    if (accountsEnabled && !isAdmin()) {
        toastr.error(t`Only admins can view server logs.`, t`Permission denied`);
        return;
    }

    const template = $(`
        <div class="userBackupManager flex-container flexFlowColumn flexNoGap">
            <h3 class="marginBot5">${t`Server Logs`}</h3>
            <div class="backupActionRow flex-container flexGap10 marginBot10">
                <div class="serverLogsRefreshButton menu_button menu_button_icon">
                    <i class="fa-fw fa-solid fa-rotate"></i>
                    <span>${t`Refresh`}</span>
                </div>
                <div class="serverLogsCopyButton menu_button menu_button_icon">
                    <i class="fa-fw fa-solid fa-copy"></i>
                    <span>${t`Copy`}</span>
                </div>
                <div class="serverLogsClearButton menu_button menu_button_icon">
                    <i class="fa-fw fa-solid fa-trash"></i>
                    <span>${t`Clear`}</span>
                </div>
                <label class="checkbox_label backupRestoreModeLabel">
                    <input type="checkbox" class="serverLogsAutoRefresh" checked>
                    <span>${t`Auto refresh`}</span>
                </label>
            </div>
            <textarea class="text_pole serverLogsOutput" rows="20" readonly></textarea>
            <div class="menu_button_note">${t`This viewer shows runtime backend logs captured in memory.`}</div>
        </div>
    `);

    const output = template.find('.serverLogsOutput');
    const autoRefresh = template.find('.serverLogsAutoRefresh');
    let latestId = 0;
    let closed = false;
    let inFlight = false;

    const renderLogs = (payload, appendOnly = false) => {
        const lines = Array.isArray(payload?.entries) ? payload.entries.map(formatServerLogEntry) : [];

        if (appendOnly) {
            const previous = String(output.val() || '');
            const next = lines.length ? `${previous}${previous ? '\n' : ''}${lines.join('\n')}` : previous;
            output.val(next);
        } else {
            output.val(lines.join('\n'));
        }

        latestId = Number(payload?.latestId) || latestId;
        output.scrollTop(output[0]?.scrollHeight || 0);
    };

    const reloadAll = async () => {
        if (inFlight || closed) {
            return;
        }

        inFlight = true;
        try {
            const payload = await fetchServerLogs(2000, 0);
            renderLogs(payload, false);
        } catch (error) {
            console.error('Failed to load server logs:', error);
            toastr.error(String(error.message || error), t`Failed to fetch server logs`);
        } finally {
            inFlight = false;
        }
    };

    const loadIncremental = async () => {
        if (inFlight || closed || !autoRefresh.is(':checked')) {
            return;
        }

        inFlight = true;
        try {
            const payload = await fetchServerLogs(500, latestId);
            renderLogs(payload, true);
        } catch {
            // Keep silent during background refresh to avoid toast spam.
        } finally {
            inFlight = false;
        }
    };

    template.find('.serverLogsRefreshButton').on('click', reloadAll);
    template.find('.serverLogsCopyButton').on('click', async () => {
        try {
            await navigator.clipboard.writeText(String(output.val() || ''));
            toastr.success(t`Logs copied to clipboard.`, t`Server Logs`);
        } catch (error) {
            console.error('Copy logs failed:', error);
            toastr.error(t`Copy failed.`, t`Server Logs`);
        }
    });
    template.find('.serverLogsClearButton').on('click', async () => {
        const confirmed = await callGenericPopup(t`Clear all captured server logs?`, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Clear`,
            cancelButton: t`Cancel`,
            wide: false,
            large: false,
        });

        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        try {
            await clearServerLogsRemote();
            output.val('');
            latestId = 0;
            toastr.success(t`Server logs cleared.`, t`Server Logs`);
        } catch (error) {
            console.error('Clear logs failed:', error);
            toastr.error(String(error.message || error), t`Failed to clear server logs`);
        }
    });

    await reloadAll();
    const timer = setInterval(loadIncremental, 1500);
    try {
        await callGenericPopup(template, POPUP_TYPE.TEXT, '', {
            okButton: t`Close`,
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            allowHorizontalScrolling: false,
        });
    } finally {
        closed = true;
        clearInterval(timer);
    }
}

/**
 * Shows a popup to change a user's password.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function changePassword(handle, callback) {
    try {
        const template = $(await renderTemplateAsync('changePassword'));
        template.find('.currentPasswordBlock').toggle(!isAdmin());
        let newPassword = '';
        let confirmPassword = '';
        let oldPassword = '';
        template.find('input[name="current"]').on('input', function () {
            oldPassword = String($(this).val());
        });
        template.find('input[name="password"]').on('input', function () {
            newPassword = String($(this).val());
        });
        template.find('input[name="confirm"]').on('input', function () {
            confirmPassword = String($(this).val());
        });
        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Change', cancelButton: 'Cancel', wide: false, large: false });
        if (result === POPUP_RESULT.CANCELLED || result === POPUP_RESULT.NEGATIVE) {
            throw new Error('Change password cancelled');
        }

        if (newPassword !== confirmPassword) {
            toastr.error('Passwords do not match', 'Failed to change password');
            throw new Error('Passwords do not match');
        }

        const response = await fetch('/api/users/change-password', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, newPassword, oldPassword }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change password');
            throw new Error('Failed to change password');
        }

        toastr.success('Password changed successfully', 'Password Changed');
        callback();
    }
    catch (error) {
        console.error('Error changing password:', error);
    }
}

/**
 * Delete a user.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function deleteUser(handle, callback) {
    try {
        if (handle === currentUser.handle) {
            toastr.error('Cannot delete yourself', 'Failed to delete user');
            throw new Error('Cannot delete yourself');
        }

        let purge = false;
        let confirmHandle = '';

        const template = $(await renderTemplateAsync('deleteUser'));
        template.find('#deleteUserName').text(handle);
        template.find('input[name="deleteUserData"]').on('input', function () {
            purge = $(this).is(':checked');
        });
        template.find('input[name="deleteUserHandle"]').on('input', function () {
            confirmHandle = String($(this).val());
        });

        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel', wide: false, large: false });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Delete user cancelled');
        }

        if (handle !== confirmHandle) {
            toastr.error('Handles do not match', 'Failed to delete user');
            throw new Error('Handles do not match');
        }

        const response = await fetch('/api/users/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, purge }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to delete user');
            throw new Error('Failed to delete user');
        }

        toastr.success('User deleted successfully', 'User Deleted');
        callback();
    } catch (error) {
        console.error('Error deleting user:', error);
    }
}

/**
 * Reset a user's settings.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function resetSettings(handle, callback) {
    try {
        let password = '';
        const template = $(await renderTemplateAsync('resetSettings'));
        template.find('input[name="password"]').on('input', function () {
            password = String($(this).val());
        });
        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Reset', cancelButton: 'Cancel', wide: false, large: false });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Reset settings cancelled');
        }

        const response = await fetch('/api/users/reset-settings', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, password }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset settings');
            throw new Error('Failed to reset settings');
        }

        toastr.success('Settings reset successfully', 'Settings Reset');
        callback();
    } catch (error) {
        console.error('Error resetting settings:', error);
    }
}

/**
 * Change a user's display name.
 * @param {string} handle User handle
 * @param {string} name Current name
 * @param {function} callback Success callback
 */
async function changeName(handle, name, callback) {
    try {
        const template = $(await renderTemplateAsync('changeName'));
        const result = await callGenericPopup(template, POPUP_TYPE.INPUT, name, { okButton: 'Change', cancelButton: 'Cancel', wide: false, large: false });

        if (!result) {
            throw new Error('Change name cancelled');
        }

        name = String(result);

        const response = await fetch('/api/users/change-name', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change name');
            throw new Error('Failed to change name');
        }

        toastr.success('Name changed successfully', 'Name Changed');
        callback();

    } catch (error) {
        console.error('Error changing name:', error);
    }
}

/**
 * Restore a settings snapshot.
 * @param {string} name Snapshot name
 * @param {function} callback Success callback
 */
async function restoreSnapshot(name, callback) {
    try {
        const confirm = await callGenericPopup(
            `Are you sure you want to restore the settings from "${name}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Restore', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Restore snapshot cancelled');
        }

        const response = await fetch('/api/settings/restore-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to restore snapshot');
            throw new Error('Failed to restore snapshot');
        }

        callback();
    } catch (error) {
        console.error('Error restoring snapshot:', error);
    }

}

/**
 * Load the content of a settings snapshot.
 * @param {string} name Snapshot name
 * @returns {Promise<string>} Snapshot content
 */
async function loadSnapshotContent(name) {
    try {
        const response = await fetch('/api/settings/load-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to load snapshot content');
            throw new Error('Failed to load snapshot content');
        }

        return response.text();
    } catch (error) {
        console.error('Error loading snapshot content:', error);
    }
}

/**
 * Gets a list of settings snapshots.
 * @returns {Promise<Snapshot[]>} List of snapshots
 * @typedef {Object} Snapshot
 * @property {string} name Snapshot name
 * @property {number} date Date in milliseconds
 * @property {number} size File size in bytes
 */
async function getSnapshots() {
    try {
        const response = await fetch('/api/settings/get-snapshots', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to get settings snapshots');
            throw new Error('Failed to get settings snapshots');
        }

        const snapshots = await response.json();
        return snapshots;
    } catch (error) {
        console.error('Error getting settings snapshots:', error);
        return [];
    }
}

/**
 * Make a snapshot of the current settings.
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function makeSnapshot(callback) {
    try {
        const response = await fetch('/api/settings/make-snapshot', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to make snapshot');
            throw new Error('Failed to make snapshot');
        }

        toastr.success('Snapshot created successfully', 'Snapshot Created');
        callback();
    } catch (error) {
        console.error('Error making snapshot:', error);
    }
}

/**
 * Open the settings snapshots view.
 */
async function viewSettingsSnapshots() {
    const template = $(await renderTemplateAsync('snapshotsView'));
    async function renderSnapshots() {
        const snapshots = await getSnapshots();
        template.find('.snapshotList').empty();

        for (const snapshot of snapshots.sort((a, b) => b.date - a.date)) {
            const snapshotBlock = template.find('.snapshotTemplate .snapshot').clone();
            snapshotBlock.find('.snapshotName').text(snapshot.name);
            snapshotBlock.find('.snapshotDate').text(new Date(snapshot.date).toLocaleString());
            snapshotBlock.find('.snapshotSize').text(humanFileSize(snapshot.size));
            snapshotBlock.find('.snapshotRestoreButton').on('click', async (e) => {
                e.stopPropagation();
                restoreSnapshot(snapshot.name, () => location.reload());
            });
            snapshotBlock.find('.inline-drawer-toggle').on('click', async () => {
                const contentBlock = snapshotBlock.find('.snapshotContent');
                if (!contentBlock.val()) {
                    const content = await loadSnapshotContent(snapshot.name);
                    contentBlock.val(content);
                }

            });
            template.find('.snapshotList').append(snapshotBlock);
        }
    }

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false, large: false, allowVerticalScrolling: true });
    template.find('.makeSnapshotButton').on('click', () => makeSnapshot(renderSnapshots));
    renderSnapshots();
}

/**
 * Reset everything to default.
 * @param {function} callback Success callback
 */
async function resetEverything(callback) {
    try {
        const step1Response = await fetch('/api/users/reset-step1', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!step1Response.ok) {
            const data = await step1Response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset');
            throw new Error('Failed to reset everything');
        }

        let password = '';
        let code = '';

        const template = $(await renderTemplateAsync('userReset'));
        template.find('input[name="password"]').on('input', function () {
            password = String($(this).val());
        });
        template.find('input[name="code"]').on('input', function () {
            code = String($(this).val());
        });
        const confirm = await callGenericPopup(
            template,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Reset', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Reset everything cancelled');
        }

        const step2Response = await fetch('/api/users/reset-step2', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ password, code }),
        });

        if (!step2Response.ok) {
            const data = await step2Response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset');
            throw new Error('Failed to reset everything');
        }

        toastr.success('Everything reset successfully', 'Reset Everything');
        callback();
    } catch (error) {
        console.error('Error resetting everything:', error);
    }

}

async function openUserProfile() {
    await getCurrentUser();
    const template = $(await renderTemplateAsync('userProfile'));
    template.find('.userName').text(currentUser.name);
    template.find('.userHandle').text(currentUser.handle);
    template.find('.avatar img').attr('src', currentUser.avatar);
    template.find('.userRole').text(currentUser.admin ? 'Admin' : 'User');
    template.find('.userCreated').text(new Date(currentUser.created).toLocaleString());
    template.find('.hasPassword').toggle(currentUser.password);
    template.find('.noPassword').toggle(!currentUser.password);
    template.find('.userSettingsSnapshotsButton').on('click', () => viewSettingsSnapshots());
    template.find('.userChangeNameButton').on('click', async () => changeName(currentUser.handle, currentUser.name, async () => {
        await getCurrentUser();
        template.find('.userName').text(currentUser.name);
    }));
    template.find('.userChangePasswordButton').on('click', () => changePassword(currentUser.handle, async () => {
        await getCurrentUser();
        template.find('.hasPassword').toggle(currentUser.password);
        template.find('.noPassword').toggle(!currentUser.password);
    }));
    template.find('.userBackupButton').on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        $(this).addClass('disabled');
        await openBackupManager(currentUser.handle, () => location.reload());
        $(this).removeClass('disabled');
    });
    template.find('.userResetSettingsButton').on('click', () => resetSettings(currentUser.handle, () => location.reload()));
    template.find('.userResetAllButton').on('click', () => resetEverything(() => location.reload()));
    template.find('.userAvatarChange').on('click', () => template.find('.avatarUpload').trigger('click'));
    template.find('.avatarUpload').on('change', async function () {
        if (!(this instanceof HTMLInputElement)) {
            return;
        }

        const file = this.files[0];
        if (!file) {
            return;
        }

        await cropAndUploadAvatar(currentUser.handle, file);
        await getCurrentUser();
        template.find('.avatar img').attr('src', currentUser.avatar);
    });
    template.find('.userAvatarRemove').on('click', async function () {
        await changeAvatar(currentUser.handle, '');
        await getCurrentUser();
        template.find('.avatar img').attr('src', currentUser.avatar);
    });

    if (!accountsEnabled) {
        template.find('[data-require-accounts]').hide();
        template.find('.accountsDisabledHint').show();
    }

    const popupOptions = {
        okButton: 'Close',
        wide: false,
        large: false,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
    };
    callGenericPopup(template, POPUP_TYPE.TEXT, '', popupOptions);
}

/**
 * Crop and upload an avatar image.
 * @param {string} handle User handle
 * @param {File} file Avatar file
 * @returns {Promise<string>}
 */
async function cropAndUploadAvatar(handle, file) {
    const dataUrl = await getBase64Async(await ensureImageFormatSupported(file));
    const croppedImage = await callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage: dataUrl });
    if (!croppedImage) {
        return;
    }

    await changeAvatar(handle, String(croppedImage));

    return String(croppedImage);
}

/**
 * Change the avatar of the user.
 * @param {string} handle User handle
 * @param {string} avatar File to upload or base64 string
 * @returns {Promise<void>} Avatar URL
 */
async function changeAvatar(handle, avatar) {
    try {
        const response = await fetch('/api/users/change-avatar', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change avatar');
            return;
        }
    } catch (error) {
        console.error('Error changing avatar:', error);
    }
}

async function openAdminPanel() {
    let currentAdminSettings = null;

    const bytesToMbInput = (value) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
            return '-1';
        }
        return String(Math.floor(n / (1024 * 1024)));
    };

    const parseIdList = (text) => String(text || '')
        .split(/[\n,]/g)
        .map(x => x.trim())
        .filter(Boolean);

    function populateAuthSettingsForm(settings) {
        if (!settings) {
            return;
        }

        template.find('#defaultUserQuotaMbInput').val(bytesToMbInput(settings?.storage?.defaultUserQuotaBytes));

        template.find('#oauthGithubEnabled').prop('checked', Boolean(settings?.oauth?.github?.enabled));
        template.find('#oauthGithubAutoCreate').prop('checked', Boolean(settings?.oauth?.github?.allowAutoCreate));
        template.find('#oauthGithubClientId').val(settings?.oauth?.github?.clientId || '');
        template.find('#oauthGithubClientSecret').val(settings?.oauth?.github?.clientSecret || '');

        template.find('#oauthDiscordEnabled').prop('checked', Boolean(settings?.oauth?.discord?.enabled));
        template.find('#oauthDiscordAutoCreate').prop('checked', Boolean(settings?.oauth?.discord?.allowAutoCreate));
        template.find('#oauthDiscordRequireGuild').prop('checked', Boolean(settings?.oauth?.discord?.requireGuildMembership));
        template.find('#oauthDiscordClientId').val(settings?.oauth?.discord?.clientId || '');
        template.find('#oauthDiscordClientSecret').val(settings?.oauth?.discord?.clientSecret || '');
        template.find('#oauthDiscordAllowedGuilds').val((settings?.oauth?.discord?.allowedGuildIds || []).join('\n'));
        template.find('#oauthDiscordRequiredRoles').val((settings?.oauth?.discord?.requiredRoleIds || []).join('\n'));
    }

    function collectAuthSettingsForm() {
        const defaultQuotaMb = Number(template.find('#defaultUserQuotaMbInput').val());
        const defaultQuotaBytes = Number.isFinite(defaultQuotaMb) && defaultQuotaMb >= 0
            ? Math.floor(defaultQuotaMb * 1024 * 1024)
            : -1;

        return {
            storage: {
                defaultUserQuotaBytes: defaultQuotaBytes,
            },
            oauth: {
                github: {
                    enabled: template.find('#oauthGithubEnabled').is(':checked'),
                    allowAutoCreate: template.find('#oauthGithubAutoCreate').is(':checked'),
                    clientId: String(template.find('#oauthGithubClientId').val() || '').trim(),
                    clientSecret: String(template.find('#oauthGithubClientSecret').val() || '').trim(),
                },
                discord: {
                    enabled: template.find('#oauthDiscordEnabled').is(':checked'),
                    allowAutoCreate: template.find('#oauthDiscordAutoCreate').is(':checked'),
                    requireGuildMembership: template.find('#oauthDiscordRequireGuild').is(':checked'),
                    clientId: String(template.find('#oauthDiscordClientId').val() || '').trim(),
                    clientSecret: String(template.find('#oauthDiscordClientSecret').val() || '').trim(),
                    allowedGuildIds: parseIdList(template.find('#oauthDiscordAllowedGuilds').val()),
                    requiredRoleIds: parseIdList(template.find('#oauthDiscordRequiredRoles').val()),
                },
            },
        };
    }

    async function promptAndSetQuota(user) {
        const currentMb = user.storageQuotaBytes == null ? '-1' : String(Math.floor(Number(user.storageQuotaBytes) / (1024 * 1024)));
        const result = await callGenericPopup(
            'Set per-user quota in MB. Enter -1 to use default/unlimited.',
            POPUP_TYPE.INPUT,
            currentMb,
            { okButton: 'Save', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (result === POPUP_RESULT.CANCELLED || result === POPUP_RESULT.NEGATIVE) {
            return;
        }

        const parsed = Number(result);
        if (!Number.isFinite(parsed)) {
            toastr.error('Please enter a valid number.', 'Invalid quota');
            return;
        }

        const bytes = parsed < 0 ? null : Math.floor(parsed * 1024 * 1024);
        await setUserQuota(user.handle, bytes, renderUsers);
    }

    async function renderOverview() {
        const overview = await getAdminOverview();
        if (!overview) {
            return;
        }

        currentAdminSettings = overview.settings || currentAdminSettings;
        if (currentAdminSettings) {
            populateAuthSettingsForm(currentAdminSettings);
        }

        const summary = template.find('.adminOverviewSummary');
        summary.empty();

        const uptimeHours = Math.floor((overview.server?.uptimeSec || 0) / 3600);
        const uptimeMinutes = Math.floor(((overview.server?.uptimeSec || 0) % 3600) / 60);
        const now = overview.server?.now ? new Date(overview.server.now).toLocaleString() : '-';

        summary.append(
            $('<div class="flex-container flexFlowColumn flexNoGap"/>')
                .append(`<div><strong>Node.js:</strong> ${overview.server?.nodeVersion || '-'}</div>`)
                .append(`<div><strong>Platform:</strong> ${overview.server?.platform || '-'}</div>`)
                .append(`<div><strong>Uptime:</strong> ${uptimeHours}h ${uptimeMinutes}m</div>`)
                .append(`<div><strong>Now:</strong> ${now}</div>`),
        );

        const defaultQuota = Number(currentAdminSettings?.storage?.defaultUserQuotaBytes);
        const quotaLabel = Number.isFinite(defaultQuota) && defaultQuota >= 0 ? humanFileSize(defaultQuota) : 'Unlimited';

        summary.append(
            $('<div class="flex-container flexFlowColumn flexNoGap"/>')
                .append(`<div><strong>Total users:</strong> ${overview.totals?.users ?? 0}</div>`)
                .append(`<div><strong>Enabled:</strong> ${overview.totals?.enabledUsers ?? 0}</div>`)
                .append(`<div><strong>Admins:</strong> ${overview.totals?.adminUsers ?? 0}</div>`)
                .append(`<div><strong>Password protected:</strong> ${overview.totals?.protectedUsers ?? 0}</div>`)
                .append(`<div><strong>Total storage:</strong> ${humanFileSize(overview.totals?.storageBytes ?? 0)}</div>`)
                .append(`<div><strong>Over quota users:</strong> ${overview.totals?.overQuotaUsers ?? 0}</div>`)
                .append(`<div><strong>Default quota:</strong> ${quotaLabel}</div>`),
        );

        const usersList = template.find('.adminOverviewUsers');
        usersList.empty();

        for (const user of overview.users || []) {
            const row = template.find('.adminOverviewUserTemplate .adminOverviewUser').clone();
            const userQuota = Number(user.storageQuotaBytes);
            const ratio = Number.isFinite(Number(user.storageUsageRatio)) ? Number(user.storageUsageRatio) : null;
            const suffix = ratio != null ? ` · ${(ratio * 100).toFixed(1)}% of quota` : '';
            row.find('.overviewUserName').text(`${user.name} (${user.handle})`);
            row.find('.overviewUserMeta').text(`${user.admin ? 'Admin' : 'User'} · ${user.enabled ? 'Enabled' : 'Disabled'}${suffix}`);
            row.find('.overviewUserStorage').text(`${humanFileSize(user.storageBytes || 0)} / ${userQuota >= 0 ? humanFileSize(userQuota) : 'Unlimited'}`);
            usersList.append(row);
        }

        const security = template.find('.adminSecurityContent');
        security.empty();

        const adminWithoutPassword = overview.security?.adminWithoutPassword || [];
        const disabledAdmins = overview.security?.disabledAdmins || [];
        const disabledUsers = overview.security?.disabledUsers || [];

        security
            .append(`<div><strong>Admins without password:</strong> ${adminWithoutPassword.length ? adminWithoutPassword.join(', ') : 'None'}</div>`)
            .append(`<div><strong>Disabled admins:</strong> ${disabledAdmins.length ? disabledAdmins.join(', ') : 'None'}</div>`)
            .append(`<div><strong>Disabled users:</strong> ${disabledUsers.length ? disabledUsers.join(', ') : 'None'}</div>`);
    }

    async function renderUsers() {
        const users = await getUsers();
        template.find('.usersList').empty();
        for (const user of users) {
            const userBlock = template.find('.userAccountTemplate .userAccount').clone();
            const quotaLabel = user.storageQuotaBytes == null ? 'Default' : humanFileSize(Number(user.storageQuotaBytes));
            const oauthProviders = Array.isArray(user.oauthProviders) && user.oauthProviders.length ? user.oauthProviders.join(', ') : 'None';

            userBlock.find('.userName').text(user.name);
            userBlock.find('.userHandle').text(user.handle);
            userBlock.find('.userStatus').text(user.enabled ? 'Enabled' : 'Disabled');
            userBlock.find('.userRole').text(user.admin ? 'Admin' : 'User');
            userBlock.find('.userQuota').text(quotaLabel);
            userBlock.find('.userOAuth').text(oauthProviders);
            userBlock.find('.avatar img').attr('src', user.avatar);
            userBlock.find('.hasPassword').toggle(user.password);
            userBlock.find('.noPassword').toggle(!user.password);
            userBlock.find('.userCreated').text(new Date(user.created).toLocaleString());
            userBlock.find('.userEnableButton').toggle(!user.enabled).on('click', () => enableUser(user.handle, renderUsers));
            userBlock.find('.userDisableButton').toggle(user.enabled).on('click', () => disableUser(user.handle, renderUsers));
            userBlock.find('.userPromoteButton').toggle(!user.admin).on('click', () => promoteUser(user.handle, renderUsers));
            userBlock.find('.userDemoteButton').toggle(user.admin).on('click', () => demoteUser(user.handle, renderUsers));
            userBlock.find('.userChangePasswordButton').on('click', () => changePassword(user.handle, renderUsers));
            userBlock.find('.userDelete').on('click', () => deleteUser(user.handle, renderUsers));
            userBlock.find('.userChangeNameButton').on('click', async () => changeName(user.handle, user.name, renderUsers));
            userBlock.find('.userQuotaButton').on('click', async () => promptAndSetQuota(user));
            userBlock.find('.userBackupButton').on('click', async function () {
                if ($(this).hasClass('disabled')) {
                    return;
                }

                $(this).addClass('disabled');
                await openBackupManager(user.handle, renderUsers);
                $(this).removeClass('disabled');
            });
            userBlock.find('.userAvatarChange').on('click', () => userBlock.find('.avatarUpload').trigger('click'));
            userBlock.find('.avatarUpload').on('change', async function () {
                if (!(this instanceof HTMLInputElement)) {
                    return;
                }

                const file = this.files[0];
                if (!file) {
                    return;
                }

                await cropAndUploadAvatar(user.handle, file);
                renderUsers();
            });
            userBlock.find('.userAvatarRemove').on('click', async function () {
                await changeAvatar(user.handle, '');
                renderUsers();
            });
            template.find('.usersList').append(userBlock);
        }

        await renderOverview();
    }

    const template = $(await renderTemplateAsync('admin'));
    currentAdminSettings = await getAdminPanelSettings();
    populateAuthSettingsForm(currentAdminSettings);

    template.find('.adminNav > button').on('click', function () {
        const target = String($(this).data('target-tab'));
        template.find('.navTab').each(function () {
            $(this).toggle(this.classList.contains(target));
        });

        if (target === 'adminOverviewTab' || target === 'adminSecurityTab' || target === 'authAndQuotaTab') {
            renderOverview();
        }
    });

    template.find('.overviewRefreshButton').on('click', renderOverview);

    template.find('.saveAuthQuotaSettingsButton').on('click', async () => {
        const payload = collectAuthSettingsForm();
        const saved = await saveAdminPanelSettings(payload);
        if (!saved) {
            return;
        }

        currentAdminSettings = saved;
        populateAuthSettingsForm(saved);
        toastr.success('Admin settings saved.', 'Saved');
        await renderOverview();
    });

    template.find('.createUserDisplayName').on('input', async function () {
        const slug = await slugify(String($(this).val()));
        template.find('.createUserHandle').val(slug);
    });

    template.find('.userCreateForm').on('submit', function (event) {
        if (!(event.target instanceof HTMLFormElement)) {
            return;
        }

        event.preventDefault();
        createUser(event.target, () => {
            template.find('.manageUsersButton').trigger('click');
            renderUsers();
        });
    });

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false, large: false, allowVerticalScrolling: true, allowHorizontalScrolling: false });
    renderUsers();
}



/**
 * Log out the current user.
 * @returns {Promise<void>}
 */
async function logout() {
    await fetch('/api/users/logout', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    // On an explicit logout stop auto login
    // to allow user to change username even
    // when auto auth (such as authelia or basic)
    // would be valid
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('noauto', 'true');

    window.location.search = urlParams.toString();
}

/**
 * Runs a text through the slugify API endpoint.
 * @param {string} text Text to slugify
 * @returns {Promise<string>} Slugified text
 */
async function slugify(text) {
    try {
        const response = await fetch('/api/users/slugify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text }),
        });

        if (!response.ok) {
            throw new Error('Failed to slugify text');
        }

        return response.text();
    } catch (error) {
        console.error('Error slugifying text:', error);
        return text;
    }
}

/**
 * Pings the server to extend the user session.
 */
async function extendUserSession() {
    try {
        const response = await fetch('/api/ping?extend=1', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error('Ping did not succeed', { cause: response.status });
        }
    } catch (error) {
        console.error('Failed to extend user session', error);
    }
}

jQuery(() => {
    $('#logout_button').on('click', () => {
        logout();
    });
    $('#admin_button').on('click', () => {
        openAdminPanel();
    });
    $('#account_button').on('click', () => {
        openUserProfile();
    });
    $('#server_logs_button').on('click', () => {
        openServerLogsViewer();
    });
    setInterval(async () => {
        if (currentUser) {
            await extendUserSession();
        }
    }, SESSION_EXTEND_INTERVAL);
});
