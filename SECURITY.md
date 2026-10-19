# Security policy

Claude Code Sync handles sensitive data: Claude Code conversation history, which can contain code, passwords and keys, and access to a GitHub account. Vulnerability reports are taken seriously.

## Supported versions

Only the latest version receives security fixes. Please check that the issue still happens on it before reporting.

| Version | Supported |
|---|---|
| Latest (see [Releases](https://github.com/lucaskge/claude-code-sync/releases)) | ✅ |
| Older | ❌ |

## How to report

**Don't open a public issue.** Use GitHub's private channel:

1. Open the repository's [**Security**](https://github.com/lucaskge/claude-code-sync/security) tab.
2. Click **Report a vulnerability**.
3. Describe:
   - what happens and its impact (for example: conversations leaked, token exposed, files written outside `~/.claude/projects`);
   - steps to reproduce;
   - the extension version, VS Code version and operating system.

**Never send real conversations, tokens or keys**, not even in the private report. Use made-up data to demonstrate the problem.

## What to expect

- Acknowledgement within **7 days**.
- If confirmed, the fix is released in a new version and disclosed in a security advisory once the fix is available. Reporters are credited if they wish.
- If the report isn't considered a vulnerability, you'll get an explanation.

This project is maintained by one person in their spare time, so these timelines are goals, not guarantees.

## Scope

In scope — problems in this extension's code, for example:

- conversations being sent to a repository other than the one the user configured;
- exposure of the GitHub token (logs, files, requests to other servers);
- reading or writing files outside `~/.claude/projects` based on data from the remote repository;
- a project opened in VS Code being able to control the extension.

Out of scope:

- design risks already documented in [Security & privacy](README.md#security--privacy), such as the `repo` scope of the GitHub sign-in or the lack of additional encryption of the backup;
- vulnerabilities in VS Code, GitHub or Claude Code itself — please report those to their maintainers.
