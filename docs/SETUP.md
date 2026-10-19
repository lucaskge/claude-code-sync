# Setup guide — Claude Code Sync

**English** · [Português](GUIA-CONFIGURACAO.md)

From zero to your first sync in about 5 minutes. **No token to create or store.**

## How the extension accesses GitHub

Your Claude Code conversations are stored in a **private repository in your GitHub account**, so the extension needs your authorization.

The recommended way is the **GitHub sign-in built into VS Code** — the same one used by Settings Sync and the GitHub Pull Requests extension:

- you click **Sign in with GitHub**, the browser opens and you authorize;
- VS Code stores and renews the access by itself;
- on a new machine, months or years from now, you just sign in again. There's nothing to write down.

> You can also use a personal access token instead — see the [appendix](#appendix--using-a-personal-access-token). It's only worth it if you want access restricted to a single repository.

## Step 1 — Install

In VS Code: `Ctrl+Shift+X` → search for **Claude Code Sync** (publisher **KS Labs**) → **Install**.

Or install a `.vsix` downloaded from [Releases](https://github.com/lucaskge/claude-code-sync/releases): `Ctrl+Shift+X` → `⋯` menu → **Install from VSIX...**, or from a terminal:

```bash
code --install-extension claude-code-session-sync-0.2.4.vsix
```

## Step 2 — Sign in with GitHub

1. Click the **Claude Sync** icon in the activity bar, then **Sign in with GitHub**. You can also use `Ctrl+Shift+P` → **Claude Sync: Configure GitHub Credentials**.
2. Choose **Sign in with GitHub** (recommended).
3. VS Code asks whether the extension may sign in with GitHub. Click **Allow**.
4. The browser opens GitHub's authorization page. Check the account and click **Authorize**.
   - If you're already signed in to GitHub inside VS Code, this step may be skipped.
5. Back in VS Code, confirm the **backup repository name**. The suggestion is `your-user/claude-code-backup`; just press Enter.
6. If the repository doesn't exist yet, the extension offers to create it as private. Click **Create private repository**.
7. You'll see **"Claude Sync configured: your-user → your-user/claude-code-backup"**.

## Step 3 — First sync (safely)

1. **Make a copy of your conversations** before the first sync:
   ```bash
   cp -r ~/.claude/projects ~/claude-projects-backup
   ```
   On Windows, copy `%USERPROFILE%\.claude\projects` to another folder.
2. In the **Claude Sync** sidebar, click **⬆️ Push** and choose **Current project**.
3. Open the repository on GitHub and check that `repos/<project-name>/` appeared, with `.jsonl` files and a `metadata.json`.
4. If everything looks right, click **🔄 Sync** to sync everything.

## On a new machine

1. Install the extension (step 1).
2. Do **step 2** with the **same GitHub account**, and enter the **same repository name** as on your first machine.
   - With VS Code **Settings Sync** turned on, the repository name is filled in automatically.
3. Click **🔄 Sync**.
4. For each project that exists in the backup but not on this machine yet, the extension asks **where that project's folder is**. Pick the folder (for example, where you cloned the repository) or **Skip this project for now**. You can sync it later, after cloning it.

## Auto-sync (optional)

In **Settings** (`Ctrl+,`), search for `Claude Sync`:

- **Auto Sync:** background sync on or off.
- **Auto Sync Interval:** how often to sync, in minutes (default: 30).
- **Sync On Startup:** sync when VS Code opens.

You can also use the **Claude Sync: Toggle Auto-Sync** command. With auto-sync on, progress only shows in the status bar: `Claude Syncing...`, then `Claude Synced`.

> Auto-sync never decides on its own where to put a project that came from another machine. New projects are downloaded after you run one manual **🔄 Sync** and choose their folder.

## Troubleshooting

The first column shows the start of each message.

| Message | Cause | Fix |
|---|---|---|
| **You are not connected to GitHub.** | You signed out of GitHub in VS Code, or haven't done step 2 yet. | Do step 2 again. |
| **Repository ... not found, or this token has no access to it.** | The repository name differs from your other machine, or it's under another account. | Use *Change Backup Repository* to fix the name, or *Switch GitHub Account*. |
| **Access denied by GitHub.** | The repository belongs to an **organization** that blocks third-party app access. | Use a repository in your personal account, or ask the organization admin to allow "Visual Studio Code". |
| **GitHub API rate limit reached.** | Too many requests in a short time. | Wait until the time shown in the message. |
| **...session currently in use by Claude Code; local update postponed...** | The conversation was open and being written. Not an error. | It's updated on the next sync. |
| **...the remote has newer events; use Pull or Sync...** | Push never overwrites what's on GitHub. | Use **🔄 Sync**. |
| **The repository ... is PUBLIC. Upload blocked...** | Your backup repository was made public. Nothing was sent. | On GitHub: repository → **Settings** → **Danger Zone** → **Change visibility** → *Private*. Then sync again. |
| **Project ... has no local folder on this machine** (in the log) | A new project arrived from another machine during auto-sync. | Run **🔄 Sync** manually once and pick the project folder. |
| A `claudeSync.*` setting in a project's `.vscode/settings.json` has no effect | For security, these settings only apply from User settings. | Set them in **Settings** (`Ctrl+,`) → **User** tab. |

For details on any sync: **Claude Sync: Show Log**.

## Switching account or repository, or disconnecting

The current account and repository are shown at the top of the **Remote Sync (GitHub)** view, for example `your-user → your-user/claude-code-backup`. These options are in the **⋯** menu of the Claude Sync views, or in `Ctrl+Shift+P`:

| Command | What it does |
|---|---|
| **Claude Sync: Change Backup Repository** | Switches only the backup repository, keeping the account. Offers to create the new repository as private. The old backup **is not deleted**. |
| **Claude Sync: Switch GitHub Account** | Choose another account already connected to VS Code, sign in with a new one, or use a token. You then confirm the repository, since the new account may not have access to the previous one. |
| **Claude Sync: Sign Out (Disconnect from GitHub)** | Disconnects Claude Sync and stops syncing (including auto-sync). **Nothing is deleted** — neither local conversations nor the backup. |

**Signing in with a different account:** if your browser is already signed in to GitHub, it will authorize that same account. Sign out on github.com first, or open the link in a **private window**.

**Signing out of VS Code entirely:** *Sign Out* only disconnects Claude Sync, because other features use the GitHub account (Settings Sync, Pull Requests, Copilot). To sign out of it too, click the **Accounts** icon (bottom left) → your GitHub account → **Sign Out**.

## About `.bak` files

When the same conversation continued on two machines, the extension merges both versions. Before that, it saves the old local version next to the original:

```
~/.claude/projects/<project>/<session-id>.jsonl.20261013-151129.bak
```

Claude Code ignores these files. Delete them once you're sure the merged version is correct.

## Security essentials

- Keep the backup repository **private** and **don't add collaborators** — anyone with write access can put conversations on your machines.
- Conversations can contain passwords and keys. If a secret ended up in one, rotate it.
- The extension creates the repository as private and **blocks uploads** if it becomes public.
- Signing in with VS Code grants the `repo` scope, which covers **all** your repositories. To restrict it to one, use a token (appendix).
- Enable two-factor authentication on GitHub.
- Revoke access anytime: [github.com/settings/applications](https://github.com/settings/applications) → **Authorized OAuth Apps** → **Visual Studio Code** → **Revoke**.

Full details: [Security & privacy](../README.md#security--privacy).

---

## Appendix — using a personal access token

Use this only if you want the extension to see **only** the backup repository.

> ⚠️ GitHub shows the token **only once**. On a new machine you'll need it again, or generate a new one. If you'd rather not deal with that, use **Sign in with GitHub**.

1. Create the private repository at [github.com/new](https://github.com/new). Fine-grained tokens can't create repositories.
2. Create the token at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):
   - **Repository access:** *Only select repositories* → your backup repository.
   - **Permissions → Repository permissions → Contents:** *Read and write*.
   - Click **Generate token** and copy it (it starts with `github_pat_`).
3. In VS Code, run **Claude Sync: Configure GitHub Credentials**, choose **Use an access token (PAT)** and paste it.

The token is stored in VS Code's secret storage. When it expires, generate a new one and repeat step 3.
