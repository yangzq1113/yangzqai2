let actionableSingleSelectCounter = 0;

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
} = {}) {
    const $select = select?.jquery ? select : $(select);
    const selectElement = $select.get(0);

    if (!(selectElement instanceof HTMLSelectElement)) {
        return;
    }

    const previousNamespace = selectElement.dataset.lukerActionableSingleSelectNamespace;
    if (previousNamespace) {
        $select.off(`select2:selecting${previousNamespace}`);
        $(document).off(`pointerdown${previousNamespace} mousedown${previousNamespace} mouseup${previousNamespace} touchstart${previousNamespace} touchend${previousNamespace} pointerup${previousNamespace}`);
    }

    const ownerKey = buildOwnerKey(selectElement);
    const namespace = `.lukerActionableSingleSelect-${ownerKey}`;
    const dropdownClasses = ['luker-action-select2-dropdown', dropdownCssClass].filter(Boolean).join(' ');
    selectElement.dataset.lukerActionableSingleSelectNamespace = namespace;

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

            if (!option?.element || option.loading || optionData.value === '' || !canDelete(optionData)) {
                return $('<span></span>').text(String(option?.text || ''));
            }

            const row = $('<div class="luker-action-select2-option"></div>');
            const label = $('<span class="luker-action-select2-option__label"></span>').text(optionData.text);
            const deleteButton = $(`
                <button type="button" class="luker-action-select2-option__delete" tabindex="-1">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            `);

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

    $select
        .off(`select2:selecting${namespace}`)
        .on(`select2:selecting${namespace}`, function (event) {
            const originalTarget = event?.params?.args?.originalEvent?.target;
            if (!isDeleteButtonTarget(originalTarget, ownerKey)) {
                return;
            }

            event.preventDefault();
        });

    $(document)
        .off(`pointerdown${namespace} mousedown${namespace} mouseup${namespace} touchstart${namespace} touchend${namespace}`)
        .on(`pointerdown${namespace} mousedown${namespace} mouseup${namespace} touchstart${namespace} touchend${namespace}`, '.luker-action-select2-option__delete', function (event) {
            if ($(this).data('lukerActionOwner') !== ownerKey) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
        });

    $(document)
        .off(`pointerup${namespace}`)
        .on(`pointerup${namespace}`, '.luker-action-select2-option__delete', async function (event) {
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
}
