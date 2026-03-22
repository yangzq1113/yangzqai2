# Luker Plugin Authoring Guide

This guide is the "from zero to working plugin" companion to the context reference:

- Read this file first if you are creating a new extension folder, wiring UI, or deciding how to structure your code.
- Read `docs/luker-api-migration.md` next for the runtime contract exposed through `Luker.getContext()`, prompt/world-info helpers, hook ordering, and advanced low-level notes.

## 1) Mental Model

Luker plugins are browser-side ES modules loaded by the web app.

Practical implications:

- Your entry file is loaded as `type="module"`.
- `manifest.json` controls discovery, order, and which JS/CSS assets are auto-loaded.
- HTML fragments are **not** auto-loaded from the manifest. Fetch or render them explicitly from your plugin code.
- `Luker.getContext()` / `getContext()` is the primary runtime contract for chat, hook, prompt, and persistence behavior.
- Plugins run in the same web app runtime as core UI code, so the usual browser tools (`console`, DevTools, Network tab) are your main debugging tools.

This is a frontend/plugin system, not a separate backend plugin API.

## 2) Where Plugins Live

Built-in examples live under:

- `public/scripts/extensions/<name>/`

Third-party plugins are served from the `third-party` namespace, typically:

- `public/scripts/extensions/third-party/<name>/`

Recommended naming:

- Use a stable ASCII folder name.
- Reuse that identity in your `MODULE_NAME` constant and any persisted settings namespace.
- Prefer lowercase plus hyphens or underscores.

## 3) Minimal Folder Layout

The smallest useful plugin usually looks like this:

```text
public/scripts/extensions/my-plugin/
  manifest.json
  index.js
  style.css              # optional
  settings.html          # optional, fetched/rendered by your code
  button.html            # optional
```

Only `manifest.json` is required for discovery. Only the files named in `manifest.json` are auto-loaded.

## 4) `manifest.json`

Minimal example:

```json
{
  "display_name": "My Plugin",
  "loading_order": 50,
  "js": "index.js",
  "css": "style.css",
  "author": "Your Name",
  "version": "0.1.0",
  "homePage": "https://example.com/my-plugin"
}
```

Supported fields you will care about most:

- `display_name`: User-facing name in extension UI.
- `loading_order`: Lower numbers load earlier.
- `js`: Entry module file. Loaded as a module script.
- `css`: Optional stylesheet loaded into `<head>`.
- `dependencies`: Other extension IDs that must exist and be enabled before this plugin loads.
- `minimum_client_version`: Optional minimum compatible Luker extension client version.
- `author`, `version`, `homePage`: Metadata shown in extension management UI.
- `auto_update`: Relevant for third-party extension update flows.

Notes:

- If you do not need CSS, omit `css`.
- HTML fragments are not declared here; fetch them from code when needed.

## 5) Minimal Working Plugin

`manifest.json`

```json
{
  "display_name": "Hello Plugin",
  "loading_order": 50,
  "js": "index.js",
  "author": "Your Name",
  "version": "0.1.0",
  "homePage": "https://example.com/hello-plugin"
}
```

`index.js`

```js
import { saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, t } from '../../i18n.js';

const MODULE_NAME = 'hello_plugin';
const defaultSettings = {
  enabled: true,
  clickCount: 0,
};

function ensureSettings() {
  if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
    extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
  }
}

function registerLocaleData() {
  addLocaleData('zh-cn', {
    'Hello Plugin': '示例插件',
    'Hello from plugin': '来自插件的问候',
  });
}

function onClick() {
  ensureSettings();

  extension_settings[MODULE_NAME].clickCount += 1;
  saveSettingsDebounced();

  const context = getContext();
  const messageCount = Array.isArray(context.chat) ? context.chat.length : 0;
  toastr.info(`${t`Hello from plugin`} (${messageCount} messages in current chat)`);
}

jQuery(() => {
  ensureSettings();
  registerLocaleData();

  const html = `
    <div id="hello_plugin_button" class="list-group-item flex-container flexGap5">
      ${t`Hello Plugin`}
    </div>
  `;

  $('#extensionsMenu').append(html);
  $('#hello_plugin_button').on('click', onClick);
});
```

What this shows:

- Stable module identity via `MODULE_NAME`
- Per-plugin persisted settings in `extension_settings[MODULE_NAME]`
- Debounced persistence via `saveSettingsDebounced()`
- Access to current chat/runtime via `getContext()`
- UI injection after DOM ready with `jQuery(() => { ... })`

## 6) Common Building Blocks

### Settings

Use `extension_settings[MODULE_NAME]` for plugin-global settings.

Recommended pattern:

- Create `defaultSettings`.
- Normalize once at startup with `ensureSettings()`.
- Persist with `saveSettingsDebounced()` for normal UI edits.
- Use immediate save only when you truly need synchronous persistence.

### Runtime Context

Use `getContext()` for:

- current chat data
- active character/group information
- generation hooks and event types
- chat state sidecars
- preset refs, live/stored preset snapshots, and preset sidecars via `context.presets`
- prompt/world-info helpers
- patch-first message and metadata persistence

Do not rebuild those behaviors with direct endpoint calls unless you are doing advanced debugging or a special integration.

### HTML Templates

If your plugin needs reusable HTML fragments, keep them next to the extension and load them yourself.

Recommended helper:

```js
import { renderExtensionTemplateAsync } from '../../extensions.js';

const html = await renderExtensionTemplateAsync('my-plugin', 'settings', { title: 'My Plugin' });
```

That loads `public/scripts/extensions/my-plugin/settings.html`.

### Localization

Typical imports:

```js
import { addLocaleData, translate, t } from '../../i18n.js';
```

Recommended pattern:

- Register your locale strings at startup.
- Use `t` for short UI labels.
- Use `translate(...)` if you need a normal function instead of a template tag.

### Hooks and Lifecycle Events

Typical flow:

```js
const context = getContext();
context.eventSource.on(context.eventTypes.MESSAGE_EDITED, handler);
```

Read the context guide for event timing and ordering details:

- `docs/luker-api-migration.md`

### Chat-bound Plugin State

If your plugin stores data that belongs to a specific chat or branch, prefer chat state sidecars over global settings.

Typical helpers:

- `getChatState(...)`
- `updateChatState(...)`
- `patchChatState(...)`
- `deleteChatState(...)`

Use these through `getContext()` rather than calling low-level chat state endpoints yourself.

### Preset Helpers

If your plugin inspects, diffs, or edits presets, use `context.presets` instead of importing `PresetManager` internals.

Typical helpers:

- `context.presets.list('openai')`
- `context.presets.getSelected('openai')`
- `context.presets.getLive('openai')`
- `context.presets.getStored({ collection: 'openai', name: 'My Preset' })`
- `context.presets.save({ collection: 'openai', name: 'My Preset' }, nextBody)`
- `context.presets.state.update(MODULE_NAME, updater, { target: presetRef })`

Practical rules:

- `collection` here means preset collection, not endpoint/proxy presets.
- Prefer `getLive(...)` when editing the preset currently open in UI.
- Prefer `getStored(...)` when comparing against other saved presets or copying content across presets.
- Use `context.presets.state.*` for plugin runtime/session data bound to a preset. Do not stuff that data into the preset body unless it is meant to ship with the preset itself.
- OpenAI character-bound runtime presets are not treated as stored refs. If one is selected, `getSelected('openai')` returns `null`, while `getLive('openai')` still lets you inspect the current live body.

## 7) Lifecycle and Cleanup

There is no single magical "plugin class" lifecycle. In practice you should manage your own resources explicitly.

Keep track of:

- DOM nodes you inject
- event listeners you register
- timers/intervals
- popup/dialog locks
- runtime providers/handles returned by helper APIs

Practical rules:

- Initialize inside `jQuery(() => { ... })` so the DOM is ready.
- Keep initialization idempotent when possible.
- If you register a provider API that returns an unregister handle, store it and call it on teardown or reload paths.
- If your plugin can open multiple dialogs, guard re-entry explicitly.
- Prefer pure functions plus a small number of stable module-level caches/maps.

## 8) UI Patterns That Already Exist in the Repo

Useful examples:

- Menu button + popup flow: `public/scripts/extensions/token-counter/`
- Persisted settings UI and event ordering: `public/scripts/extensions/hook-order/`
- Rich plugin with settings, popups, tool calls, and patch-first behavior: `public/scripts/extensions/search-tools/`
- Asset-heavy plugin with templates: `public/scripts/extensions/attachments/`

When in doubt, copy a nearby built-in extension that matches your UI shape instead of inventing a new local pattern.

## 9) Choosing the Right Persistence Layer

Use the simplest layer that matches the scope of your data:

- `extension_settings[MODULE_NAME]`: plugin-global settings/preferences
- `chat_metadata`: lightweight chat metadata that should remain visible with the chat itself
- chat state sidecars: larger or more structured per-chat plugin state
- lorebook/world-info helpers: source-backed context material that should participate in generation

Rule of thumb:

- If it is a user preference, use `extension_settings`.
- If it belongs to one chat branch only, use chat state sidecars.
- If it must affect prompt assembly or retrieval, use the context/lorebook helpers.

## 10) Debugging Checklist

If a plugin does not appear or does not run:

1. Check that `/scripts/extensions/<name>/manifest.json` is reachable.
2. Check that `manifest.json` points to the correct `js` and `css` filenames.
3. Open DevTools and inspect the browser console for module import errors.
4. Check whether the extension is disabled in `extension_settings.disabledExtensions`.
5. If you use `dependencies`, confirm the dependent extensions exist and are enabled.
6. If you load HTML templates manually, verify the relative path matches the extension folder.

If the plugin loads but behaves incorrectly:

- log the current `getContext()` snapshot you depend on
- verify your settings normalization runs before UI reads
- verify per-chat state uses the correct target
- inspect generated network calls only after confirming a context helper does not already solve the problem

## 11) Recommended Reading Order

For a new plugin:

1. Start with this file to create the folder, manifest, entry module, and UI scaffold.
2. Move to `docs/luker-api-migration.md` for the runtime/context contract.
3. Copy a built-in extension whose UI and lifecycle resemble your use case.

For an existing legacy plugin:

1. Read `docs/luker-api-migration.md` first.
2. Migrate persistence and generation hooks onto context helpers.
3. Come back here only if you also want to restructure packaging/UI/layout.
