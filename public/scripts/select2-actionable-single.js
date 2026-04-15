let actionableSingleSelectCounter = 0;

/** @type {Map<string, Set<string>>} ownerKey -> collapsed group IDs (session-only) */
const collapsedGroupsMap = new Map();

function buildOwnerKey(selectElement) {
    const baseId = String(selectElement?.id || 'select')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'select';
    actionableSingleSelectCounter += 1;
    return `luker-action-select-${baseId}-${actionableSingleSelectCounter}`;
}

function getOptionData(option, selectElement, ownerKey) {
    const value = String(option?.id ?? '');
    const text = String(option?.text ?? '').trim();
    const element = option?.element instanceof HTMLOptionElement ? option.element : null;

    return {
        ownerKey,
        value,
        text,
        element,
        selectElement,
    };
}

function isDeleteButtonTarget(target, ownerKey) {
    if (!(target instanceof Element)) {
        return false;
    }

    const button = target.closest('.luker-action-select2-option__delete');
    return button instanceof HTMLElement && button.dataset.lukerActionOwner === ownerKey;
}

function isGroupHeaderTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    return !!target.closest('.luker-preset-group-header');
}

function isGroupActionTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    return !!target.closest('.luker-preset-group-action');
}

/**
 * Applies collapsed state to the select2 dropdown.
 * Hides/shows group member LIs based on collapsed groups.
 * @param {HTMLSelectElement} selectElement
 * @param {Set<string>} collapsedGroups
 */
function applyCollapsedState(selectElement, collapsedGroups) {
    const $dropdown = $(selectElement).data('select2')?.$dropdown;
    if (!$dropdown?.length) return;

    $dropdown.find('.select2-results__option').each(function () {
        const $li = $(this);
        const $content = $li.children().first();

        // Group member
        if ($content.hasClass('luker-preset-group-member')) {
            const groupId = $content.attr('data-preset-group-id');
            if (groupId && collapsedGroups.has(groupId)) {
                $li.addClass('luker-preset-group-member--hidden');
            } else {
                $li.removeClass('luker-preset-group-member--hidden');
            }
        }

        // Group header chevron
        if ($content.hasClass('luker-preset-group-header')) {
            const groupId = $content.attr('data-preset-group-id');
            const $chevron = $content.find('.luker-preset-group-chevron');
            if (groupId && collapsedGroups.has(groupId)) {
                $chevron.removeClass('luker-preset-group-chevron--expanded');
            } else {
                $chevron.addClass('luker-preset-group-chevron--expanded');
            }
        }
    });
}

/**
 * Dismisses any open preset context menu.
 */
function dismissContextMenu() {
    $('.luker-preset-ctx-menu').remove();
}

/**
 * Shows a context menu for a preset option.
 * @param {MouseEvent} event
 * @param {string} presetName
 * @param {object} callbacks
 * @param {HTMLSelectElement} selectElement
 * @param {string} ownerKey
 */
function showPresetContextMenu(event, presetName, callbacks, selectElement, ownerKey) {
    dismissContextMenu();
    if (!callbacks) return;

    const groups = callbacks.getGroups();
    const currentGroup = callbacks.getGroupForPreset(presetName);

    const $menu = $('<div class="luker-preset-ctx-menu"></div>');

    // "New Group..." option
    const $newGroup = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--new"></div>')
        .html('<i class="fa-solid fa-folder-plus"></i> New Group...')
        .on('click', async (e) => {
            e.stopPropagation();
            dismissContextMenu();
            const name = prompt('Group name:');
            if (!name?.trim()) return;
            const groupId = await callbacks.createGroup(name.trim());
            if (groupId) {
                await callbacks.addToGroup(presetName, groupId);
            }
        });
    $menu.append($newGroup);

    // Existing groups
    if (groups.length > 0) {
        $menu.append('<div class="luker-preset-ctx-menu__divider"></div>');
        for (const group of groups) {
            const isActive = currentGroup?.id === group.id;
            const $item = $('<div class="luker-preset-ctx-menu__item"></div>')
                .text(group.name)
                .toggleClass('luker-preset-ctx-menu__item--active', isActive)
                .on('click', async (e) => {
                    e.stopPropagation();
                    dismissContextMenu();
                    if (isActive) {
                        await callbacks.removeFromGroup(presetName);
                    } else {
                        await callbacks.addToGroup(presetName, group.id);
                    }
                });
            if (isActive) {
                $item.prepend('<i class="fa-solid fa-check"></i> ');
            }
            $menu.append($item);
        }
    }

    // "Remove from group" if currently grouped
    if (currentGroup) {
        $menu.append('<div class="luker-preset-ctx-menu__divider"></div>');
        const $remove = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--remove"></div>')
            .html('<i class="fa-solid fa-folder-minus"></i> Remove from Group')
            .on('click', async (e) => {
                e.stopPropagation();
                dismissContextMenu();
                await callbacks.removeFromGroup(presetName);
            });
        $menu.append($remove);
    }

    // Position and show
    $menu.css({
        position: 'fixed',
        left: event.clientX + 'px',
        top: event.clientY + 'px',
        zIndex: 99999,
    });

    $(document.body).append($menu);

    // Dismiss on outside click (next tick)
    requestAnimationFrame(() => {
        $(document).one('pointerdown.lukerCtxMenu', (e) => {
            if (!$(e.target).closest('.luker-preset-ctx-menu').length) {
                dismissContextMenu();
            }
        });
    });
}

/**
 * Initializes a single-select Select2 with optional inline delete actions.
 * @param {JQuery<HTMLElement>|HTMLElement|string} select
 * @param {object} [options]
 * @param {string} [options.placeholder]
 * @param {string} [options.searchInputPlaceholder]
 * @param {boolean} [options.allowClear=false]
 * @param {boolean} [options.closeOnSelect=true]
 * @param {string} [options.deleteButtonTitle='Delete']
 * @param {(option: { ownerKey: string, value: string, text: string, element: HTMLOptionElement|null, selectElement: HTMLSelectElement }) => boolean} [options.canDelete]
 * @param {(option: { ownerKey: string, value: string, text: string, element: HTMLOptionElement|null, selectElement: HTMLSelectElement }) => Promise<void>|void} [options.onDelete]
 * @param {string} [options.containerCssClass]
 * @param {string} [options.dropdownCssClass]
 * @param {object} [options.select2Options]
 * @param {object} [options.presetGroupCallbacks]
 */
export function initActionableSingleSelect(select, {
    placeholder = '',
    searchInputPlaceholder = '',
    allowClear = false,
    closeOnSelect = true,
    deleteButtonTitle = 'Delete',
    canDelete = () => false,
    onDelete = null,
    containerCssClass = '',
    dropdownCssClass = '',
    select2Options = {},
    presetGroupCallbacks = null,
} = {}) {
    const $select = select?.jquery ? select : $(select);
    const selectElement = $select.get(0);

    if (!(selectElement instanceof HTMLSelectElement)) {
        return;
    }

    const previousNamespace = selectElement.dataset.lukerActionableSingleSelectNamespace;
    if (previousNamespace) {
        $select.off(`select2:selecting${previousNamespace} select2:open${previousNamespace}`);
        $(document).off(`pointerdown${previousNamespace} mousedown${previousNamespace} mouseup${previousNamespace} touchstart${previousNamespace} touchend${previousNamespace} pointerup${previousNamespace} contextmenu${previousNamespace}`);
    }

    const ownerKey = buildOwnerKey(selectElement);
    const namespace = `.lukerActionableSingleSelect-${ownerKey}`;
    const dropdownClasses = ['luker-action-select2-dropdown', dropdownCssClass].filter(Boolean).join(' ');
    selectElement.dataset.lukerActionableSingleSelectNamespace = namespace;

    // Initialize collapsed groups set for this owner
    if (!collapsedGroupsMap.has(ownerKey)) {
        collapsedGroupsMap.set(ownerKey, new Set());
    }
    const collapsedGroups = collapsedGroupsMap.get(ownerKey);

    if ($select.data('select2')) {
        $select.select2('destroy');
    }

    $select.select2({
        placeholder,
        searchInputPlaceholder,
        allowClear,
        closeOnSelect,
        multiple: false,
        dropdownCssClass: dropdownClasses,
        templateResult: (option) => {
            const optionData = getOptionData(option, selectElement, ownerKey);
            const element = option?.element;

            // === Group header ===
            if (element?.dataset?.presetGroupHeader === 'true') {
                const groupId = element.dataset.presetGroupId;
                const isCollapsed = collapsedGroups.has(groupId);

                const header = $('<div class="luker-preset-group-header"></div>')
                    .attr('data-preset-group-id', groupId)
                    .attr('data-luker-action-owner', ownerKey);
                const chevron = $('<i class="fa-solid fa-chevron-right luker-preset-group-chevron"></i>')
                    .toggleClass('luker-preset-group-chevron--expanded', !isCollapsed);
                const label = $('<span class="luker-preset-group-header__label"></span>').text(option.text);

                const memberCount = $(selectElement).find('option[data-preset-group-id="' + groupId + '"][data-preset-group-member="true"]').length;
                const count = $('<span class="luker-preset-group-header__count"></span>').text('(' + memberCount + ')');

                const actions = $('<span class="luker-preset-group-header__actions"></span>');
                const renameBtn = $('<button type="button" class="luker-preset-group-action" tabindex="-1"></button>')
                    .attr('data-action', 'rename')
                    .attr('data-group-id', groupId)
                    .attr('data-luker-action-owner', ownerKey)
                    .html('<i class="fa-solid fa-pen"></i>');
                const deleteBtn = $('<button type="button" class="luker-preset-group-action" tabindex="-1"></button>')
                    .attr('data-action', 'delete')
                    .attr('data-group-id', groupId)
                    .attr('data-luker-action-owner', ownerKey)
                    .html('<i class="fa-solid fa-trash-can"></i>');
                actions.append(renameBtn, deleteBtn);

                header.append(chevron, label, count, actions);
                return header;
            }

            // === Group member ===
            if (element?.dataset?.presetGroupMember === 'true') {
                const groupId = element.dataset.presetGroupId;

                const row = $('<div class="luker-action-select2-option luker-preset-group-member"></div>')
                    .attr('data-preset-group-id', groupId);
                const label = $('<span class="luker-action-select2-option__label"></span>').text(optionData.text);
                row.append(label);

                if (canDelete(optionData)) {
                    const deleteButton = $('<button type="button" class="luker-action-select2-option__delete" tabindex="-1"><i class="fa-solid fa-trash-can"></i></button>')
                        .attr('title', deleteButtonTitle)
                        .attr('aria-label', deleteButtonTitle)
                        .attr('data-luker-action-owner', ownerKey)
                        .attr('data-option-value', optionData.value)
                        .attr('data-option-text', optionData.text);
                    row.append(deleteButton);
                }

                return row;
            }

            // === Ungrouped (original logic) ===
            if (!option?.element || option.loading || optionData.value === '' || !canDelete(optionData)) {
                return $('<span></span>').text(String(option?.text || ''));
            }

            const row = $('<div class="luker-action-select2-option"></div>');
            const label = $('<span class="luker-action-select2-option__label"></span>').text(optionData.text);
            const deleteButton = $('<button type="button" class="luker-action-select2-option__delete" tabindex="-1"><i class="fa-solid fa-trash-can"></i></button>');

            deleteButton
                .attr('title', deleteButtonTitle)
                .attr('aria-label', deleteButtonTitle)
                .attr('data-luker-action-owner', ownerKey)
                .attr('data-option-value', optionData.value)
                .attr('data-option-text', optionData.text);

            row.append(label, deleteButton);
            return row;
        },
        ...select2Options,
    });

    $select.next('.select2-container')
        .addClass('luker-action-select2')
        .addClass(containerCssClass);

    // === select2:open - apply collapsed state & default-collapse new groups ===
    $select
        .off('select2:open' + namespace)
        .on('select2:open' + namespace, function () {
            // Default-collapse any groups not yet tracked
            if (presetGroupCallbacks) {
                const groups = presetGroupCallbacks.getGroups();
                for (const group of groups) {
                    if (!collapsedGroups.has(group.id) && !collapsedGroups._initialized?.has(group.id)) {
                        collapsedGroups.add(group.id);
                    }
                }
                // Mark as initialized so we don't re-collapse after user expands
                if (!collapsedGroups._initialized) {
                    Object.defineProperty(collapsedGroups, '_initialized', { value: new Set(), writable: false, enumerable: false });
                }
                for (const group of groups) {
                    collapsedGroups._initialized.add(group.id);
                }
            }

            // Apply after a microtask to let select2 finish rendering
            requestAnimationFrame(() => {
                applyCollapsedState(selectElement, collapsedGroups);
            });
        });

    // === Prevent selection of group headers and action buttons ===
    $select
        .off('select2:selecting' + namespace)
        .on('select2:selecting' + namespace, function (event) {
            const originalTarget = event?.params?.args?.originalEvent?.target;
            if (isDeleteButtonTarget(originalTarget, ownerKey)) {
                event.preventDefault();
                return;
            }
            if (isGroupHeaderTarget(originalTarget) || isGroupActionTarget(originalTarget)) {
                event.preventDefault();
                return;
            }
        });

    // === Pointer events for delete buttons, group headers, group actions ===
    $(document)
        .off('pointerdown' + namespace + ' mousedown' + namespace + ' mouseup' + namespace + ' touchstart' + namespace + ' touchend' + namespace)
        .on('pointerdown' + namespace + ' mousedown' + namespace + ' mouseup' + namespace + ' touchstart' + namespace + ' touchend' + namespace, '.luker-action-select2-option__delete, .luker-preset-group-header, .luker-preset-group-action', function (event) {
            const $el = $(this);
            // Only handle events for our owner
            if ($el.data('lukerActionOwner') !== ownerKey && $el.closest('[data-luker-action-owner]').data('lukerActionOwner') !== ownerKey) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
        });

    // === Delete button handler ===
    $(document)
        .off('pointerup' + namespace)
        .on('pointerup' + namespace, '.luker-action-select2-option__delete', async function (event) {
            if ($(this).data('lukerActionOwner') !== ownerKey || typeof onDelete !== 'function') {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const value = String($(this).data('optionValue') ?? '');
            const text = String($(this).data('optionText') ?? '').trim();
            const optionElement = Array.from(selectElement.options).find((option) => String(option.value) === value && String(option.textContent || '').trim() === text) || null;
            const optionData = {
                ownerKey,
                value,
                text,
                element: optionElement,
                selectElement,
            };

            if (!canDelete(optionData)) {
                return;
            }

            if ($select.data('select2')) {
                $select.select2('close');
            }

            try {
                await onDelete(optionData);
            } catch (error) {
                console.error('Actionable single select delete handler failed', error);
            }
        });

    // === Group header click - toggle collapse ===
    $(document)
        .off('click' + namespace + '.groupHeader')
        .on('click' + namespace + '.groupHeader', '.luker-preset-group-header', function (event) {
            const $header = $(this);
            if ($header.data('lukerActionOwner') !== ownerKey) {
                return;
            }

            // Don't toggle if clicking action buttons
            if ($(event.target).closest('.luker-preset-group-action').length) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const groupId = $header.attr('data-preset-group-id');
            if (!groupId) return;

            if (collapsedGroups.has(groupId)) {
                collapsedGroups.delete(groupId);
            } else {
                collapsedGroups.add(groupId);
            }

            applyCollapsedState(selectElement, collapsedGroups);
        });

    // === Group action buttons (rename/delete) ===
    $(document)
        .off('click' + namespace + '.groupAction')
        .on('click' + namespace + '.groupAction', '.luker-preset-group-action', async function (event) {
            if ($(this).data('lukerActionOwner') !== ownerKey || !presetGroupCallbacks) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const action = $(this).data('action');
            const groupId = $(this).data('groupId');

            if (action === 'rename') {
                const groups = presetGroupCallbacks.getGroups();
                const group = groups.find(g => g.id === groupId);
                if (!group) return;

                const newName = prompt('Rename group:', group.name);
                if (!newName?.trim() || newName.trim() === group.name) return;

                if ($select.data('select2')) {
                    $select.select2('close');
                }

                await presetGroupCallbacks.renameGroup(groupId, newName.trim());
            } else if (action === 'delete') {
                if (!confirm('Delete this group? Presets will become ungrouped.')) return;

                if ($select.data('select2')) {
                    $select.select2('close');
                }

                collapsedGroups.delete(groupId);
                await presetGroupCallbacks.deleteGroup(groupId);
            }
        });

    // === Context menu on preset options ===
    if (presetGroupCallbacks) {
        $(document)
            .off('contextmenu' + namespace)
            .on('contextmenu' + namespace, '.luker-action-select2-dropdown .select2-results__option', function (event) {
                const $li = $(this);
                const $content = $li.children().first();

                // Only for selectable options (not headers)
                if ($content.hasClass('luker-preset-group-header')) {
                    return;
                }

                // Get the preset name from the label
                const $label = $content.find('.luker-action-select2-option__label');
                const presetName = $label.length ? $label.text().trim() : $content.text().trim();
                if (!presetName) return;

                // Check owner
                const $owner = $content.find('[data-luker-action-owner]');
                if ($owner.length && $owner.data('lukerActionOwner') !== ownerKey) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();

                showPresetContextMenu(event.originalEvent, presetName, presetGroupCallbacks, selectElement, ownerKey);
            });
    }
}
