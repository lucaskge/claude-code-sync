# Contributing

Thanks for your interest! Bug fixes, features, tests, documentation and translations are all welcome.

## Before you start

- **Bugs and ideas:** open an issue describing the problem or proposal. For larger changes, discuss in the issue before writing code.
- **Security vulnerabilities:** **don't** open a public issue. Follow the [security policy](SECURITY.md).
- **Never paste real Claude Code conversations** into issues, pull requests or tests. They can contain code, passwords and keys. Use made-up data.

## Setting up

Requirements: Node.js 22+ and VS Code 1.85+.

```bash
git clone https://github.com/lucaskge/claude-code-sync.git
cd claude-code-sync
npm install
npm test
```

To try the extension, open the folder in VS Code and press **F5**. A new window opens with the extension loaded.

> 💡 For manual testing, use a **separate test repository** for the backup and, if possible, point Claude Code to a separate folder
> with the `CLAUDE_CONFIG_DIR` environment variable so your real conversations stay untouched.

### Project structure

| Path | Contents |
|---|---|
| `src/extension.ts` | Activation, commands, sign-in and UI |
| `src/services/syncEngine.ts` | Sync engine and `.jsonl` merge |
| `src/services/githubService.ts` | GitHub REST API client |
| `src/services/claudeStorageService.ts` | Reading and writing `~/.claude/projects` |
| `src/services/chunkedStorage.ts` | Compression and splitting of large files |
| `src/views/claudeTreeDataProvider.ts` | Sidebar trees |
| `src/test/` | Tests (`node --test`) |

```bash
npm run compile    # compile TypeScript to out/
npm run watch      # recompile on change
npm test           # compile and run tests
npm run package    # build the .vsix
```

## Submitting a change

1. Fork the repository and create a branch: `git checkout -b my-change`.
2. Make your change. Follow the style of the surrounding code (strict TypeScript; code comments are in Portuguese). User-facing text goes through `t()` — see [Translations](#translations).
3. **Add or update tests** in `src/test/` when behavior changes, especially in merge and sync logic.
4. Run `npm test` and make sure everything passes.
5. Open a pull request explaining **what** changed and **why**. Tests run automatically on Linux, Windows and macOS.

## Rules that can't be broken

The extension touches people's conversation history. Every change must keep these guarantees:

- **No local conversation is ever deleted or truncated.** When in doubt, keep both sides and create a `.bak`.
- **Data from GitHub is untrusted:** validate paths, names and sizes before using them. Nothing may be written outside `~/.claude/projects`.
- **Tokens never go into logs**, error messages or files.
- **No network requests** other than `https://api.github.com`. No telemetry.
- `claudeSync.*` settings stay restricted to user settings (`application`/`machine` scope in `package.json`).

## Translations

The interface follows VS Code's display language. English is the source language; translations live in:

| File | Contents |
|---|---|
| `l10n/bundle.l10n.<locale>.json` | Messages from the code, keyed by the English text |
| `package.nls.json` / `package.nls.<locale>.json` | Command titles, view names, settings descriptions |

**Adding or changing a message:** write it in English inside `t()` (from `src/i18n.ts`), using `{0}`, `{1}`... for values, then add the same key to every `l10n/bundle.l10n.*.json` file:

```ts
log(t('Backup created: {0}', backup));
```

```json
"Backup created: {0}": "Backup criado: {0}"
```

`npm test` fails if a message has no translation, if a translation is no longer used, or if the `{0}` placeholders differ.

**Adding a language:** copy `l10n/bundle.l10n.pt-br.json` and `package.nls.pt-br.json` with the new locale ID (for example `es`, `de`, `ja`), translate the values and open a pull request.

## Releases (maintainers)

1. Bump the version: `npm version patch --no-git-tag-version` (or `minor` / `major`).
2. Add an entry to [CHANGELOG.md](CHANGELOG.md).
3. Commit, push, then tag:
   ```bash
   git tag v0.2.4
   git push origin v0.2.4
   ```
   The [release workflow](.github/workflows/release.yml) checks that the tag matches `package.json`, runs the tests, builds the `.vsix` and publishes a GitHub Release.

## License

By contributing, you agree that your contribution will be licensed under the project's [MIT license](LICENSE).
