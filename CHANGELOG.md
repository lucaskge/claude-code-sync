# Changelog

All notable changes to this project are documented here.

## [0.2.5] — 2026-10-19

### Changed
- New sidebar icon, matching the extension icon (chat bubble with sync arrows).
- Screenshots in the README.

### Fixed
- Project folder detection now also reads session files with spaces in the JSON (`"cwd": "..."`).

## [0.2.4] — 2026-10-19

### Added
- **English interface.** The extension now follows VS Code's display language: English by default, Portuguese (Brazil) when VS Code is in Portuguese.
- Comparison with snapshot-based sync tools in the README.

### Changed
- Documentation rewritten in English (README, setup guide, contributing guide and security policy). The Portuguese versions are still available.
- Marketplace description and keywords in English.

### Fixed
- Tests now run on Windows (the test file pattern is expanded by Node instead of the shell).

## [0.2.3] — 2026-10-19

First public release on the Visual Studio Marketplace.

### Added
- Extension icon.
- Repository, issue tracker and homepage links.

### Security
- Settings are now user-level only: a project's `.vscode/settings.json` can no longer change the backup repository, the token or auto-sync.
- Uploads are blocked if the backup repository becomes public.
- Data from the remote repository is validated: project and session names, chunk manifests, metadata, and file sizes.
- Decompression of split files is limited to their declared size (protection against "zip bombs").
- Repository names are validated against GitHub's rules before being used in API requests.
- Paths of the same project on other machines are only offered as suggestions, never used automatically.
- The plain-text `claudeSync.githubToken` setting is no longer included in Settings Sync.
- Line identification in the merge uses SHA-256 instead of SHA-1.

## [0.2.1]

### Added
- Large sessions are compressed and split into parts, avoiding GitHub's upload size limit.
