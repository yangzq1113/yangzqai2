# Luker

Luker is a fork of SillyTavern focused on cleaner APIs, stronger extension hooks, and better generation lifecycle handling.

## What Luker Adds

- Incremental chat persistence APIs (`append`, `patch`, `meta/patch`, `state/patch`) to avoid repeated full-payload saves.
- Backend-owned generation job tracking and recovery for active/finished stream state after reconnect.
- Prompt-preset-aware extension helpers and world-info simulation hooks for plugin workflows.
- Built-in `Orchestrator` and `Memory` plugins.

## Luker API Guide

- Luker API additions and migration notes: [`docs/luker-api-migration.md`](docs/luker-api-migration.md)

## Upstream Resources (SillyTavern)

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
