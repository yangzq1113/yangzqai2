export function createCharacterEditorDiffUi(deps) {
    const {
        buildLineDiffRows,
        buildLineDiffOperations,
        buildLineDiffVisualRows,
        escapeHtml,
        i18n,
        i18nFormat,
        lineDiffLcsMaxCells,
        sanitizeDiffPlaceholderValue,
    } = deps;

    function splitInlineDiffTokens(text) {
        const source = String(text ?? '');
        return source.length > 0 ? (source.match(/\s+|[^\s]+/g) || []) : [];
    }

    function renderInlineDiffHtml(beforeText, afterText, mode = 'old') {
        const beforeTokens = splitInlineDiffTokens(beforeText);
        const afterTokens = splitInlineDiffTokens(afterText);
        if (beforeTokens.length === 0 && afterTokens.length === 0) {
            return '&nbsp;';
        }
        if ((beforeTokens.length * afterTokens.length) > lineDiffLcsMaxCells) {
            const fallback = escapeHtml(mode === 'new' ? String(afterText ?? '') : String(beforeText ?? ''));
            return fallback.length > 0 ? fallback : '&nbsp;';
        }
        const operations = buildLineDiffOperations(beforeTokens, afterTokens);
        const chunks = [];
        for (const operation of operations) {
            const type = String(operation?.type || 'equal');
            const tokenText = escapeHtml(String((Array.isArray(operation?.lines) ? operation.lines : []).join('')));
            if (!tokenText) {
                continue;
            }
            if (type === 'equal') {
                chunks.push(tokenText);
                continue;
            }
            if (type === 'delete') {
                if (mode === 'old') {
                    chunks.push(`<span class="cea_line_diff_word_del">${tokenText}</span>`);
                }
                continue;
            }
            if (type === 'insert' && mode === 'new') {
                chunks.push(`<span class="cea_line_diff_word_add">${tokenText}</span>`);
            }
        }
        return chunks.length > 0 ? chunks.join('') : '&nbsp;';
    }

    function renderLineDiffSideRowsHtml(rows, side = 'old') {
        const safeRows = Array.isArray(rows) ? rows : [];
        const isOldSide = side !== 'new';
        return safeRows.map((row) => `
<tr class="cea_line_diff_row ${escapeHtml(String(row?.rowType || ''))}">
    <td class="cea_line_diff_ln ${isOldSide ? 'old' : 'new'}">${isOldSide ? escapeHtml(String(row?.oldLine || '')) : escapeHtml(String(row?.newLine || ''))}</td>
    <td class="cea_line_diff_text ${isOldSide ? 'old' : 'new'}"><div class="cea_line_diff_text_inner">${isOldSide ? String(row?.oldHtml || '&nbsp;') : String(row?.newHtml || '&nbsp;')}</div></td>
</tr>`).join('');
    }

    function renderLineDiffHtml(beforeValue, afterValue, fileLabel = 'field') {
        const payload = buildLineDiffRows(
            sanitizeDiffPlaceholderValue(beforeValue),
            sanitizeDiffPlaceholderValue(afterValue),
        );
        const summary = i18nFormat('Line diff (+${0} -${1})', payload.added, payload.removed);
        const safeLabel = escapeHtml(String(fileLabel || 'field'));
        const renderedRows = buildLineDiffVisualRows(payload.operations);
        const expandLabel = escapeHtml(i18n('Expand diff'));
        const resizeLabel = escapeHtml(i18n('Resize diff columns'));
        return `
<details class="cea_line_diff"${payload.openByDefault ? ' open' : ''}>
    <summary>
        <span class="cea_line_diff_summary_main">
            <span>${escapeHtml(summary)}</span>
            <span class="cea_line_diff_meta">=${escapeHtml(String(payload.unchanged))}</span>
        </span>
        <button type="button" class="menu_button menu_button_small cea_line_diff_expand_btn" data-cea-action="expand-line-diff" title="${expandLabel}" aria-label="${expandLabel}">
            <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
        </button>
    </summary>
    <div class="cea_line_diff_pre" data-cea-diff-label="${safeLabel}">
        <div class="cea_line_diff_dual" role="group">
            <div class="cea_line_diff_side old">
                <div class="cea_line_diff_side_scroll">
                    <table class="cea_line_diff_table old" role="grid">
                        <tbody>${renderLineDiffSideRowsHtml(renderedRows, 'old')}</tbody>
                    </table>
                </div>
            </div>
            <div class="cea_line_diff_splitter" role="separator" aria-orientation="vertical" aria-label="${resizeLabel}" title="${resizeLabel}"></div>
            <div class="cea_line_diff_side new">
                <div class="cea_line_diff_side_scroll">
                    <table class="cea_line_diff_table new" role="grid">
                        <tbody>${renderLineDiffSideRowsHtml(renderedRows, 'new')}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</details>`;
    }

    function closeCeaExpandedDiff(target) {
        const node = target instanceof Element ? target : null;
        const popupRoot = node?.closest?.('.popup');
        if (!(popupRoot instanceof HTMLElement)) {
            return;
        }
        popupRoot.querySelectorAll('.cea_line_diff_zoom_overlay').forEach((overlay) => overlay.remove());
    }

    function openCeaExpandedDiff(trigger) {
        const triggerElement = trigger instanceof Element ? trigger : null;
        const popupRoot = triggerElement?.closest?.('.popup');
        const diffRoot = triggerElement?.closest?.('.cea_line_diff');
        const diffBody = diffRoot?.querySelector?.('.cea_line_diff_pre');
        if (!(popupRoot instanceof HTMLElement) || !(diffBody instanceof HTMLElement)) {
            return;
        }

        popupRoot.querySelectorAll('.cea_line_diff_zoom_overlay').forEach((overlay) => overlay.remove());

        const diffLabel = String(diffBody.getAttribute('data-cea-diff-label') || i18n('Line diff'));
        const closeLabel = escapeHtml(i18n('Close expanded diff'));
        const overlay = document.createElement('div');
        overlay.className = 'cea_line_diff_zoom_overlay';
        overlay.innerHTML = `
<div class="cea_line_diff_zoom_backdrop" data-cea-action="close-line-diff-zoom"></div>
<div class="cea_line_diff_zoom_dialog" role="dialog" aria-modal="true">
    <div class="cea_line_diff_zoom_header">
        <div class="cea_line_diff_zoom_title">${escapeHtml(diffLabel)}</div>
        <button type="button" class="menu_button menu_button_small cea_line_diff_zoom_close" data-cea-action="close-line-diff-zoom" title="${closeLabel}" aria-label="${closeLabel}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    </div>
    <div class="cea_line_diff_zoom_body"></div>
</div>`;

        const zoomBody = overlay.querySelector('.cea_line_diff_zoom_body');
        if (zoomBody instanceof HTMLElement) {
            zoomBody.append(diffBody.cloneNode(true));
        }

        popupRoot.append(overlay);
    }

    function beginCeaLineDiffResize(splitterElement, pointerEvent) {
        const splitter = splitterElement instanceof HTMLElement ? splitterElement : null;
        const pointer = pointerEvent instanceof PointerEvent ? pointerEvent : null;
        const dual = splitter?.closest?.('.cea_line_diff_dual');
        if (!(splitter instanceof HTMLElement) || !(pointer instanceof PointerEvent) || !(dual instanceof HTMLElement)) {
            return;
        }

        pointer.preventDefault();
        pointer.stopPropagation();

        const bounds = dual.getBoundingClientRect();
        if (!Number.isFinite(bounds.width) || bounds.width <= 0) {
            return;
        }

        const minPercent = 15;
        const maxPercent = 85;
        const pointerId = pointer.pointerId;

        const applySplitAt = (clientX) => {
            const nextPercent = ((clientX - bounds.left) / bounds.width) * 100;
            const clampedPercent = Math.max(minPercent, Math.min(maxPercent, nextPercent));
            dual.style.setProperty('--cea-split-left', `${clampedPercent}%`);
        };

        const cleanup = () => {
            splitter.classList.remove('active');
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
            try {
                splitter.releasePointerCapture(pointerId);
            } catch {
                // Ignore release errors when capture was not acquired.
            }
        };

        const handlePointerMove = (moveEvent) => {
            if (!(moveEvent instanceof PointerEvent) || moveEvent.pointerId !== pointerId) {
                return;
            }
            moveEvent.preventDefault();
            applySplitAt(moveEvent.clientX);
        };

        const handlePointerUp = (upEvent) => {
            if (!(upEvent instanceof PointerEvent) || upEvent.pointerId !== pointerId) {
                return;
            }
            upEvent.preventDefault();
            cleanup();
        };

        splitter.classList.add('active');
        try {
            splitter.setPointerCapture(pointerId);
        } catch {
            // Ignore capture errors and keep the drag handlers attached.
        }
        applySplitAt(pointer.clientX);
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerUp);
    }

    return {
        beginCeaLineDiffResize,
        closeCeaExpandedDiff,
        openCeaExpandedDiff,
        renderInlineDiffHtml,
        renderLineDiffHtml,
        renderLineDiffSideRowsHtml,
    };
}
