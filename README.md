# Luker

Luker is a SillyTavern fork focused on cleaner API behavior, stronger extension hooks, and production-grade generation lifecycle handling.

## Why Luker

- Reliable generation lifecycle: backend-owned generation jobs keep running and persisting even if the frontend disconnects/reloads, and active output can be recovered after reconnect.
- Incremental chat persistence: message/content changes are patch-first instead of repeated full chat saves.
- Better plugin ergonomics: prompt-preset-aware message assembly, world-info simulation/finalization hooks, and chat-bound plugin state helpers.
- Built-in advanced plugins: `Orchestrator` (multi-agent planning) and `Memory` (graph memory + recall).

## Developer Quick Start (Plugins)

Use `getContext()` as the primary integration surface.

- Persistence helpers:
  - `appendChatMessages(messages)`
  - `patchChatMessages(operations)`
  - `saveChatMetadata(withMetadata?)`
  - `getChatState(namespace, options?)`
  - `patchChatState(namespace, operations, options?)`
  - `deleteChatState(namespace, options?)`
- Prompt/world-info helpers:
  - `buildPresetAwarePromptMessages(options)`
  - `simulateWorldInfoActivation(options?)`
- Generation lifecycle hooks (`context.eventSource.on(context.eventTypes.*)`):
  - `GENERATION_BEFORE_WORLD_INFO_SCAN`
  - `GENERATION_AFTER_WORLD_INFO_SCAN`
  - `GENERATION_WORLD_INFO_FINALIZED`
  - `GENERATION_BEFORE_API_REQUEST`
  - `GENERATION_STARTED` / `GENERATION_STOPPED` / `GENERATION_ENDED`

Detailed migration and API notes:
- [`docs/luker-api-migration.md`](docs/luker-api-migration.md)

## Upstream Resources (SillyTavern)

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
