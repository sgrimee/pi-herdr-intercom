# Changelog

All notable changes to this project are documented here.

This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- Push the pi-intercom name to Herdr as `display_agent`, keep the Herdr agent name in sync, and adopt an existing Herdr name for unnamed sessions.
- Publish intercom traffic as Herdr pane tokens (`$ic_name`, `$ic_last`, `$ic_wait`, `$ic_peers`, `$ic_count`, `$ic_awaiting`, `$ic_todo`, `$ic_open`, `$ic_waits`, `$ic_replies`).
- Track open conversations heuristically, closing sent messages once Herdr shows the recipient has finished with them.
- `/herdr-intercom` status command and `/herdr-intercom layout` sidebar snippet.
- Environment switches for each behaviour.
