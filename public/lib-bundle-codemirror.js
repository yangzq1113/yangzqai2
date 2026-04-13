/**
 * CodeMirror 6 bundle for CardApp Studio code editor.
 * Lazy-loaded only when the Studio is opened.
 */
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';

export {
    // View
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLineGutter,
    highlightSpecialChars,
    drawSelection,
    dropCursor,
    rectangularSelection,
    crosshairCursor,
    highlightActiveLine,
    // State
    EditorState,
    Compartment,
    // Language
    defaultHighlightStyle,
    syntaxHighlighting,
    indentOnInput,
    bracketMatching,
    foldGutter,
    foldKeymap,
    // Languages
    javascript,
    css,
    html,
    json,
    markdown,
    // Autocomplete
    autocompletion,
    completionKeymap,
    closeBrackets,
    closeBracketsKeymap,
    // Commands
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    // Search
    searchKeymap,
    highlightSelectionMatches,
    // Lint
    lintKeymap,
    // Theme
    oneDark,
};
