import * as vscode from 'vscode';

import { setTranslator, t } from './i18n';
import { ClaudeStorageService, encodeProjectPath } from './services/claudeStorageService';
import { GitHubError, GitHubService, parseRepoInput } from './services/githubService';
import { RemoteProject, SessionRef, SyncBusyError, SyncDirection, SyncEngine, SyncHost, SyncReport, SyncScope } from './services/syncEngine';
import { ClaudeTreeDataProvider, ClaudeTreeItem, formatDate, formatSize, itemsToScope } from './views/claudeTreeDataProvider';

const SECRET_TOKEN_KEY = 'claudeSync.githubToken';
const SIGNED_OUT_KEY = 'claudeSync.signedOut';
const GITHUB_AUTH_PROVIDER = 'github';
/** "repo" é necessário para ler e gravar em repositórios privados. */
const GITHUB_SCOPES = ['repo'];
const MAPPINGS_KEY = 'claudeSync.projectMappings';
/** Repositório público que o usuário aceitou usar explicitamente ("dono/repo" em minúsculas). */
const PUBLIC_REPO_ALLOWED_KEY = 'claudeSync.publicRepoAllowed';
const CONFIG = 'claudeSync';

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let autoSyncTimer: NodeJS.Timeout | undefined;
let startupTimer: NodeJS.Timeout | undefined;
let lastAutoSyncErrorKind: string | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setTranslator((message, ...args) => vscode.l10n.t(message, ...args));
  output = vscode.window.createOutputChannel('Claude Sync');
  context.subscriptions.push(output);

  const storage = new ClaudeStorageService();

  const host: SyncHost = {
    getGitHub: () => createGitHubService(context),
    getMappings: () => context.globalState.get<Record<string, string>>(MAPPINGS_KEY, {}),
    setMapping: async (folderName, projectKey) => {
      const mappings = { ...context.globalState.get<Record<string, string>>(MAPPINGS_KEY, {}), [folderName]: projectKey };
      await context.globalState.update(MAPPINGS_KEY, mappings);
      log(t('Local folder "{0}" mapped to remote project "{1}".', folderName, projectKey));
    },
    workspacePaths: () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
    askLocalPathForProject: askLocalPathForProject,
    isPublicRepoAllowed: (fullName) => context.globalState.get<string>(PUBLIC_REPO_ALLOWED_KEY) === fullName,
    log,
  };

  const engine = new SyncEngine(storage, host);
  const isConfigured = async () => !!(await getRepoSetting()) && !!(await getToken(context));

  const localTree = new ClaudeTreeDataProvider('local', engine, storage, isConfigured);
  const remoteTree = new ClaudeTreeDataProvider('remote', engine, storage, isConfigured);
  const localView = vscode.window.createTreeView('claudeSync.localView', { treeDataProvider: localTree, canSelectMany: true, showCollapseAll: true });
  const remoteView = vscode.window.createTreeView('claudeSync.remoteView', { treeDataProvider: remoteTree, canSelectMany: true, showCollapseAll: true });
  context.subscriptions.push(localView, remoteView);

  /** Recarrega o estado remoto (para os ícones de status das sessões locais) e redesenha as duas árvores. */
  const refreshAll = async (forceRemote: boolean) => {
    if (await isConfigured()) {
      try {
        await engine.getRemoteState(forceRemote);
      } catch (err) {
        log(t('Failed to read the remote repository: {0}', (err as Error).message));
      }
    }
    const connection = await describeConnection(context);
    remoteView.description = connection;
    localTree.refresh();
    remoteTree.refresh();
  };

  const updateConfiguredContext = async () => {
    await vscode.commands.executeCommand('setContext', 'claudeSync.configured', await isConfigured());
  };

  // ---- Status bar --------------------------------------------------------------------------------------------
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'claudeSync.fullSync';
  setStatus('idle');
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ---- Execução de sincronização --------------------------------------------------------------------------------
  const runSync = async (direction: SyncDirection, scope: SyncScope, mode: 'manual' | 'auto'): Promise<SyncReport | undefined> => {
    if (engine.isRunning) {
      if (mode === 'manual') {
        void vscode.window.showInformationMessage(t('Claude Sync: a sync is already in progress.'));
      }
      return undefined;
    }
    if (!(await isConfigured())) {
      if (mode === 'manual') {
        const choice = await vscode.window.showWarningMessage(t('Claude Sync is not configured yet.'), t('Configure now'));
        if (choice) {
          await vscode.commands.executeCommand('claudeSync.configure');
        }
      }
      return undefined;
    }

    setStatus('syncing');
    log(`=== ${labelFor(direction)} iniciado (${mode}) — escopo: ${describeScope(scope)} ===`);
    try {
      const execute = (onProgress?: (msg: string) => void) => engine.run({ direction, scope, interactive: mode === 'manual', onProgress });
      const report =
        mode === 'manual'
          ? await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Claude Sync: ${labelFor(direction)}` },
              (progress) => execute((message) => progress.report({ message })),
            )
          : await execute();

      logReport(report);
      setStatus('done', summarize(report));
      lastAutoSyncErrorKind = undefined;
      if (mode === 'manual') {
        await showReport(report);
      } else if (report.warnings.length) {
        log(t('Auto-sync finished with {0} warning(s).', report.warnings.length));
      }
      return report;
    } catch (err) {
      if (err instanceof SyncBusyError) {
        setStatus('idle');
        return undefined;
      }
      handleSyncError(err, mode);
      return undefined;
    } finally {
      await refreshAll(false);
    }
  };

  // ---- Comandos ----------------------------------------------------------------------------------------------
  const register = (command: string, handler: (...args: never[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler as (...args: unknown[]) => unknown));
  };

  const afterCredentialsChange = async (changed: boolean) => {
    if (changed) {
      engine.invalidateRemote();
      await updateConfiguredContext();
      await refreshAll(true);
    }
  };
  register('claudeSync.configure', async () => afterCredentialsChange(await configureCredentials(context)));
  register('claudeSync.changeRepository', async () => afterCredentialsChange(await changeRepository(context)));
  register('claudeSync.switchAccount', async () => afterCredentialsChange(await switchAccount(context)));
  register('claudeSync.signOut', async () => {
    if (await signOut(context)) {
      setStatus('idle');
      await afterCredentialsChange(true);
    }
  });

  register('claudeSync.fullSync', () => runSync('sync', { kind: 'all' }, 'manual'));

  register('claudeSync.push', async () => {
    const scope = await pickScope('push', engine, storage);
    if (scope) {
      await runSync('push', scope, 'manual');
    }
  });

  register('claudeSync.pull', async () => {
    const scope = await pickScope('pull', engine, storage);
    if (scope) {
      await runSync('pull', scope, 'manual');
    }
  });

  register('claudeSync.selectSessions', async () => {
    const direction = await pickDirection();
    if (!direction) {
      return;
    }
    const sessions = await pickSessions(direction, engine, storage);
    if (sessions?.length) {
      await runSync(direction, { kind: 'sessions', sessions }, 'manual');
    }
  });

  register('claudeSync.refresh', () => refreshAll(true));

  register('claudeSync.toggleAutoSync', async () => {
    const config = vscode.workspace.getConfiguration(CONFIG);
    const enabled = !config.get<boolean>('autoSync', false);
    await config.update('autoSync', enabled, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      enabled ? t('Claude Sync: auto-sync on (every {0} min).', config.get<number>('autoSyncInterval', 30)) : t('Claude Sync: auto-sync off.'),
    );
  });

  register('claudeSync.showLog', () => output.show());

  const itemCommand = (direction: SyncDirection) => async (item?: ClaudeTreeItem, selected?: ClaudeTreeItem[]) => {
    const items = selected?.length ? selected : item ? [item] : [];
    if (items.length === 0) {
      await vscode.commands.executeCommand(direction === 'push' ? 'claudeSync.push' : direction === 'pull' ? 'claudeSync.pull' : 'claudeSync.fullSync');
      return;
    }
    const { projectKeys, sessions } = itemsToScope(items);
    const scope: SyncScope = sessions.length ? { kind: 'sessions', sessions, wholeProjects: projectKeys } : { kind: 'projects', keys: projectKeys };
    await runSync(direction, scope, 'manual');
  };
  register('claudeSync.pushItem', itemCommand('push'));
  register('claudeSync.pullItem', itemCommand('pull'));
  register('claudeSync.syncItem', itemCommand('sync'));

  register('claudeSync.openSession', async (item?: ClaudeTreeItem) => {
    const file = item?.localSession?.mainFile;
    if (!file) {
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      void vscode.window.showWarningMessage(t('Large file ({0}); VS Code may not open it in the editor.', formatSize(file.size)));
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file.absPath), { preview: true });
  });

  register('claudeSync.revealProject', async (item?: ClaudeTreeItem) => {
    if (item?.localProject) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.localProject.dirPath));
    }
  });

  // ---- Auto-sync ---------------------------------------------------------------------------------------------
  const scheduleAutoSync = (isStartup: boolean) => {
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = undefined;
    }
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    const config = vscode.workspace.getConfiguration(CONFIG);
    if (!config.get<boolean>('autoSync', false)) {
      log(t('Auto-sync off.'));
      return;
    }
    const minutes = Math.max(1, config.get<number>('autoSyncInterval', 30));
    autoSyncTimer = setInterval(() => void runSync('sync', { kind: 'all' }, 'auto'), minutes * 60_000);
    log(t('Auto-sync on, every {0} minute(s).', minutes));
    if (isStartup && config.get<boolean>('syncOnStartup', true)) {
      // Pequeno atraso para não competir com a inicialização do VS Code.
      startupTimer = setTimeout(() => void runSync('sync', { kind: 'all' }, 'auto'), 15_000);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(`${CONFIG}.autoSync`) || event.affectsConfiguration(`${CONFIG}.autoSyncInterval`)) {
        scheduleAutoSync(false);
      }
      if (event.affectsConfiguration(`${CONFIG}.githubRepoUrl`) || event.affectsConfiguration(`${CONFIG}.githubToken`)) {
        engine.invalidateRemote();
        await updateConfiguredContext();
        await refreshAll(true);
      }
    }),
    vscode.authentication.onDidChangeSessions(async (event) => {
      if (event.provider.id === GITHUB_AUTH_PROVIDER) {
        engine.invalidateRemote();
        await updateConfiguredContext();
        await refreshAll(true);
      }
    }),
    context.secrets.onDidChange(async (event) => {
      if (event.key === SECRET_TOKEN_KEY) {
        engine.invalidateRemote();
        await updateConfiguredContext();
      }
    }),
    { dispose: () => autoSyncTimer && clearInterval(autoSyncTimer) },
    { dispose: () => startupTimer && clearTimeout(startupTimer) },
  );

  // ---- Observa a pasta local do Claude Code para atualizar a árvore -----------------------------------------------
  let refreshDebounce: NodeJS.Timeout | undefined;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(storage.projectsDir), '*/*.jsonl'));
  const scheduleLocalRefresh = () => {
    if (refreshDebounce) {
      clearTimeout(refreshDebounce);
    }
    refreshDebounce = setTimeout(() => localTree.refresh(), 10_000);
  };
  watcher.onDidCreate(scheduleLocalRefresh);
  watcher.onDidDelete(scheduleLocalRefresh);
  watcher.onDidChange(scheduleLocalRefresh);
  context.subscriptions.push(watcher, { dispose: () => refreshDebounce && clearTimeout(refreshDebounce) });

  await updateConfiguredContext();
  scheduleAutoSync(true);
  void refreshAll(false);
  log(t('Claude Sync active. Claude Code folder: {0}', storage.projectsDir));
}

export function deactivate(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
  }
}

// =================================================================================================================
// Credenciais
// =================================================================================================================

async function getRepoSetting(): Promise<string> {
  return vscode.workspace.getConfiguration(CONFIG).get<string>('githubRepoUrl', '').trim();
}

/**
 * Ordem de busca da credencial:
 *   1. token manual salvo pelo comando de configuração (cofre do VS Code);
 *   2. login do GitHub embutido no VS Code (sem token para guardar; o VS Code renova sozinho);
 *   3. token em texto puro na configuração claudeSync.githubToken.
 * Depois de "Sign Out", nenhuma credencial é usada até o usuário se conectar de novo.
 */
async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (context.globalState.get<boolean>(SIGNED_OUT_KEY, false)) {
    return undefined;
  }
  const secret = await context.secrets.get(SECRET_TOKEN_KEY);
  if (secret) {
    return secret;
  }
  try {
    const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, GITHUB_SCOPES, { silent: true });
    if (session) {
      return session.accessToken;
    }
  } catch {
    // provedor de autenticação indisponível (ex: VS Code sem a extensão GitHub Authentication)
  }
  const fromSettings = vscode.workspace.getConfiguration(CONFIG).get<string>('githubToken', '').trim();
  return fromSettings || undefined;
}

async function createGitHubService(context: vscode.ExtensionContext): Promise<GitHubService> {
  const repoInput = await getRepoSetting();
  const ref = parseRepoInput(repoInput);
  if (!ref) {
    throw new GitHubError(
      repoInput ? t('Invalid repository URL: "{0}". Use https://github.com/user/repo or user/repo.', repoInput) : t('GitHub repository not configured.'),
      'notFound',
    );
  }
  const token = await getToken(context);
  if (!token) {
    throw new GitHubError(t('You are not connected to GitHub. Run "Claude Sync: Configure GitHub Credentials" and choose "Sign in with GitHub".'), 'auth');
  }
  return new GitHubService(ref, token, log);
}

interface GitHubAuth {
  token: string;
  login: string;
  method: 'login' | 'token';
}

const loginCache = new Map<string, string>();

/** Conta do GitHub dona do token (com cache, para exibir na interface sem gastar requisições). */
async function loginForToken(token: string): Promise<string> {
  const cached = loginCache.get(token);
  if (cached) {
    return cached;
  }
  const login = await new GitHubService({ owner: '', repo: '' }, token, log).getAuthenticatedLogin();
  loginCache.set(token, login);
  return login;
}

/** Descrição curta da conexão atual ("usuario → usuario/repo"), ou undefined se não houver. */
async function describeConnection(context: vscode.ExtensionContext): Promise<string | undefined> {
  const token = await getToken(context);
  const repo = parseRepoInput(await getRepoSetting());
  if (!token || !repo) {
    return undefined;
  }
  try {
    return `${await loginForToken(token)} → ${repo.owner}/${repo.repo}`;
  } catch {
    return `${repo.owner}/${repo.repo}`;
  }
}

/** Pergunta como acessar o GitHub (login do VS Code ou token manual). */
async function chooseAuth(context: vscode.ExtensionContext, title: string): Promise<GitHubAuth | undefined> {
  const method = await vscode.window.showQuickPick(
    [
      {
        label: `$(github) ${t('Sign in with GitHub')}`,
        description: t('recommended'),
        detail: t('Browser sign-in, like VS Code Settings Sync. No token to create or store.'),
        method: 'login' as const,
      },
      {
        label: `$(key) ${t('Use an access token (PAT)')}`,
        detail: t('For a token restricted to a single repository (fine-grained). See the setup guide.'),
        method: 'token' as const,
      },
    ],
    { title, ignoreFocusOut: true },
  );
  if (!method) {
    return undefined;
  }
  return method.method === 'login' ? signInWithGitHub('default') : askManualToken(context);
}

/**
 * Login pelo provedor GitHub do VS Code.
 *  - default: usa a conta já conectada (ou abre o login se não houver);
 *  - pick:    deixa escolher entre as contas já conectadas no VS Code;
 *  - new:     força um login novo (para entrar com outra conta).
 */
async function signInWithGitHub(mode: 'default' | 'pick' | 'new'): Promise<GitHubAuth | undefined> {
  try {
    let session: vscode.AuthenticationSession;
    if (mode === 'new') {
      session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, GITHUB_SCOPES, {
        forceNewSession: { detail: t('Sign in with the other GitHub account. Tip: if the browser signs in to the current account automatically, sign out of it on github.com or use a private window.') },
        clearSessionPreference: true,
      });
    } else {
      session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, GITHUB_SCOPES, { createIfNone: true, clearSessionPreference: mode === 'pick' });
    }
    loginCache.set(session.accessToken, session.account.label);
    return { token: session.accessToken, login: session.account.label, method: 'login' };
  } catch (err) {
    void vscode.window.showErrorMessage(t('Claude Sync: GitHub sign-in not completed ({0}).', (err as Error).message));
    return undefined;
  }
}

async function askManualToken(context: vscode.ExtensionContext): Promise<GitHubAuth | undefined> {
  const existingManual = await context.secrets.get(SECRET_TOKEN_KEY);
  const tokenInput = await vscode.window.showInputBox({
    title: t('Claude Sync: GitHub access token'),
    prompt: existingManual
      ? t('New token (leave empty to keep the current one). Classic: "repo" scope. Fine-grained: "Contents: Read and write".')
      : t('Create it at github.com/settings/personal-access-tokens/new with "Contents: Read and write". It is kept in VS Code secret storage.'),
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (!value && !existingManual ? t('Enter the token, or go back and choose "Sign in with GitHub" so no token is needed.') : undefined),
  });
  if (tokenInput === undefined) {
    return undefined;
  }
  const token = tokenInput.trim() || existingManual!;
  try {
    return { token, login: await loginForToken(token), method: 'token' };
  } catch (err) {
    void vscode.window.showErrorMessage(`Claude Sync: ${(err as Error).message}`);
    return undefined;
  }
}

/** Pergunta, valida (ou cria) e salva o repositório de backup. Retorna "dono/repo" ou undefined se cancelado. */
async function chooseRepository(context: vscode.ExtensionContext, auth: GitHubAuth, title: string): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration(CONFIG);
  const current = config.get<string>('githubRepoUrl', '');
  const repoInput = await vscode.window.showInputBox({
    title,
    prompt: t('Signed in as {0}. Repository that will store your sessions; if it does not exist, it will be created as private. Use the same one on every machine.', auth.login),
    placeHolder: `${auth.login}/claude-code-backup`,
    value: current || `${auth.login}/claude-code-backup`,
    ignoreFocusOut: true,
    validateInput: (value) => (parseRepoInput(value) ? undefined : t('Enter user/repo, https://github.com/user/repo or git@github.com:user/repo.git')),
  });
  if (repoInput === undefined) {
    return undefined;
  }
  const gh = new GitHubService(parseRepoInput(repoInput)!, auth.token, log);
  let publicAccepted = false;
  try {
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Claude Sync: checking repository access...') }, async () => {
      try {
        const repo = await gh.getRepository();
        if (repo.permissions && repo.permissions.push === false) {
          void vscode.window.showWarningMessage(t('The account {0} has no write access to {1}; only Pull will work.', auth.login, repo.full_name));
        }
        if (!repo.private) {
          const useAnyway = t('Use anyway');
          const answer = await vscode.window.showWarningMessage(
            t('The repository {0} is PUBLIC. Your Claude conversations can contain code and secrets. Use it anyway?', repo.full_name),
            { modal: true },
            useAnyway,
          );
          publicAccepted = answer === useAnyway;
          return publicAccepted;
        }
        return true;
      } catch (err) {
        if (err instanceof GitHubError && err.kind === 'notFound') {
          const create = t('Create private repository');
          const answer = await vscode.window.showInformationMessage(
            t('The repository {0} does not exist (or the account {1} has no access to it). Create it now as a private repository?', gh.fullName, auth.login),
            { modal: true },
            create,
          );
          if (answer !== create) {
            return false;
          }
          await gh.createPrivateRepository();
          log(t('Private repository {0} created.', gh.fullName));
          return true;
        }
        throw err;
      }
    });
    if (!ok) {
      return undefined;
    }
  } catch (err) {
    const hint =
      auth.method === 'token' && err instanceof GitHubError && (err.kind === 'forbidden' || err.kind === 'notFound')
        ? ` ${t('Fine-grained tokens cannot create repositories: create it on GitHub and include it in the token.')}`
        : '';
    void vscode.window.showErrorMessage(`Claude Sync: ${(err as Error).message}${hint}`);
    return undefined;
  }
  await context.globalState.update(PUBLIC_REPO_ALLOWED_KEY, publicAccepted ? gh.fullName.toLowerCase() : undefined);
  await config.update('githubRepoUrl', repoInput.trim(), vscode.ConfigurationTarget.Global);
  return gh.fullName;
}

/** Grava a credencial escolhida e reativa a extensão caso ela tenha sido desconectada. */
async function saveAuth(context: vscode.ExtensionContext, auth: GitHubAuth): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG);
  if (auth.method === 'token') {
    await context.secrets.store(SECRET_TOKEN_KEY, auth.token);
  } else {
    // O token manual tem prioridade; removê-lo garante que o login escolhido seja usado.
    await context.secrets.delete(SECRET_TOKEN_KEY);
  }
  await context.globalState.update(SIGNED_OUT_KEY, false);
  if (config.get<string>('githubToken', '')) {
    const remove = t('Remove');
    const answer = await vscode.window.showInformationMessage(
      t('There is a plain-text token in "claudeSync.githubToken" in settings.json that is no longer needed. Remove it?'),
      remove,
      t('Keep'),
    );
    if (answer === remove) {
      await config.update('githubToken', undefined, vscode.ConfigurationTarget.Global);
    }
  }
  log(t('Connected to GitHub as {0} ({1}).', auth.login, auth.method === 'login' ? t('VS Code sign-in') : t('manual token')));
}

/** Configuração completa: conta + repositório. */
async function configureCredentials(context: vscode.ExtensionContext): Promise<boolean> {
  const auth = await chooseAuth(context, t('Claude Sync (1/2): how should it access GitHub?'));
  if (!auth) {
    return false;
  }
  const repo = await chooseRepository(context, auth, t('Claude Sync (2/2): private GitHub repository'));
  if (!repo) {
    return false;
  }
  await saveAuth(context, auth);
  void vscode.window.showInformationMessage(t('Claude Sync configured: {0} → {1}.', auth.login, repo));
  return true;
}

/** Troca só o repositório de backup, mantendo a conta atual. */
async function changeRepository(context: vscode.ExtensionContext): Promise<boolean> {
  const token = await getToken(context);
  if (!token) {
    return configureCredentials(context);
  }
  let login: string;
  try {
    login = await loginForToken(token);
  } catch (err) {
    void vscode.window.showErrorMessage(`Claude Sync: ${(err as Error).message}`);
    return false;
  }
  const method = (await context.secrets.get(SECRET_TOKEN_KEY)) ? 'token' : 'login';
  const previous = await getRepoSetting();
  const repo = await chooseRepository(context, { token, login, method }, t('Claude Sync: change backup repository'));
  if (!repo) {
    return false;
  }
  void vscode.window.showInformationMessage(
    previous && parseRepoInput(previous) && `${parseRepoInput(previous)!.owner}/${parseRepoInput(previous)!.repo}`.toLowerCase() !== repo.toLowerCase()
      ? t('Claude Sync now uses {0}. The backup in {1} was not changed or deleted.', repo, previous)
      : t('Claude Sync using {0}.', repo),
  );
  return true;
}

/** Troca a conta do GitHub (outra conta já conectada no VS Code, um login novo ou um token manual). */
async function switchAccount(context: vscode.ExtensionContext): Promise<boolean> {
  const current = await describeConnection(context);
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: `$(account) ${t('Choose among accounts already connected to VS Code')}`,
        detail: t('If VS Code has more than one GitHub account, you pick which one to use.'),
        mode: 'pick' as const,
      },
      {
        label: `$(sign-in) ${t('Sign in with another GitHub account')}`,
        detail: t('Opens the browser sign-in. If it signs in to the current account by itself, sign out of it on github.com or use a private window.'),
        mode: 'new' as const,
      },
      {
        label: `$(key) ${t('Use an access token (PAT)')}`,
        detail: t('Token restricted to a single repository.'),
        mode: 'token' as const,
      },
    ],
    { title: t('Claude Sync: switch GitHub account'), placeHolder: current ? t('Current connection: {0}', current) : undefined, ignoreFocusOut: true },
  );
  if (!choice) {
    return false;
  }
  const auth = choice.mode === 'token' ? await askManualToken(context) : await signInWithGitHub(choice.mode);
  if (!auth) {
    return false;
  }
  // A nova conta pode não ter acesso ao repositório atual: confirma (ou troca) o repositório.
  const repo = await chooseRepository(context, auth, t('Claude Sync: backup repository for this account'));
  if (!repo) {
    return false;
  }
  await saveAuth(context, auth);
  void vscode.window.showInformationMessage(t('Claude Sync now connected as {0} → {1}.', auth.login, repo));
  return true;
}

/** Desconecta a extensão do GitHub. Não apaga conversas locais nem o backup remoto. */
async function signOut(context: vscode.ExtensionContext): Promise<boolean> {
  if (!(await getToken(context))) {
    void vscode.window.showInformationMessage(t('Claude Sync is not connected to GitHub.'));
    return false;
  }
  const current = await describeConnection(context);
  const disconnect = t('Disconnect');
  const answer = await vscode.window.showWarningMessage(
    current ? t('Disconnect Claude Sync from GitHub ({0})?', current) : t('Disconnect Claude Sync from GitHub?'),
    {
      modal: true,
      detail: t('Syncing (including auto-sync) stops until you connect again. Your local conversations and the GitHub backup are NOT deleted.'),
    },
    disconnect,
  );
  if (answer !== disconnect) {
    return false;
  }
  await context.secrets.delete(SECRET_TOKEN_KEY);
  await context.globalState.update(SIGNED_OUT_KEY, true);
  loginCache.clear();
  log(t('Claude Sync disconnected from GitHub.'));
  const connectAnother = t('Connect another account');
  const next = await vscode.window.showInformationMessage(
    t('Claude Sync disconnected. The GitHub account stays connected to VS Code (other features use it); to sign out of it too, use the Accounts menu in the bottom-left corner.'),
    connectAnother,
  );
  if (next === connectAnother) {
    await vscode.commands.executeCommand('claudeSync.configure');
  }
  return true;
}

// =================================================================================================================
// Seletores (QuickPick)
// =================================================================================================================

type ScopeChoice = 'all' | 'current' | 'projects' | 'sessions';

async function pickScope(direction: SyncDirection, engine: SyncEngine, storage: ClaudeStorageService): Promise<SyncScope | undefined> {
  const hasWorkspace = (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === 'file');
  const items: (vscode.QuickPickItem & { choice: ScopeChoice })[] = [
    { label: `$(globe) ${t('Everything')}`, description: direction === 'push' ? t('all local projects') : t('all projects in the repository'), choice: 'all' },
    ...(hasWorkspace ? [{ label: `$(root-folder) ${t('Current project')}`, description: t('project open in this VS Code'), choice: 'current' as const }] : []),
    { label: `$(list-selection) ${t('Selected projects...')}`, choice: 'projects' },
    { label: `$(comment-discussion) ${t('Specific conversations...')}`, choice: 'sessions' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: direction === 'push' ? t('Claude Sync: Push — what?') : t('Claude Sync: Pull — what?'), ignoreFocusOut: true });
  if (!picked) {
    return undefined;
  }

  switch (picked.choice) {
    case 'all':
      return { kind: 'all' };
    case 'current': {
      const keys = await pickCurrentProjectKeys(engine);
      return keys?.length ? { kind: 'projects', keys } : undefined;
    }
    case 'projects': {
      const keys = await pickProjects(direction, engine);
      return keys?.length ? { kind: 'projects', keys } : undefined;
    }
    case 'sessions': {
      const sessions = await pickSessions(direction, engine, storage);
      return sessions?.length ? { kind: 'sessions', sessions } : undefined;
    }
  }
}

async function pickDirection(): Promise<SyncDirection | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: `$(sync) ${t('Sync (bi-directional)')}`, direction: 'sync' as const, description: t('lossless merge both ways') },
      { label: `$(cloud-upload) ${t('Upload (Push)')}`, direction: 'push' as const, description: 'local → GitHub' },
      { label: `$(cloud-download) ${t('Download (Pull)')}`, direction: 'pull' as const, description: 'GitHub → local' },
    ],
    { title: t('Claude Sync: what to do with the selected conversations?'), ignoreFocusOut: true },
  );
  return picked?.direction;
}

async function pickCurrentProjectKeys(engine: SyncEngine): Promise<string[] | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  let selected = folders;
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { title: t('Which workspace folder?'), canPickMany: true, ignoreFocusOut: true },
    );
    if (!picked?.length) {
      return undefined;
    }
    selected = picked.map((p) => p.folder);
  }
  const keys: string[] = [];
  for (const folder of selected) {
    const key = await engine.resolveKeyForPath(folder.uri.fsPath);
    log(t('Workspace {0} -> remote project "{1}" (Claude folder: {2})', folder.uri.fsPath, key, encodeProjectPath(folder.uri.fsPath)));
    keys.push(key);
  }
  return keys;
}

async function loadRemoteForPicker(engine: SyncEngine): Promise<Map<string, RemoteProject>> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Claude Sync: reading the remote repository...') }, async () => {
    return (await engine.getRemoteState(true)).projects;
  });
}

async function pickProjects(direction: SyncDirection, engine: SyncEngine): Promise<string[] | undefined> {
  const entries = new Map<string, { label: string; local: number; remote: number; path?: string }>();
  for (const project of direction !== 'pull' ? await engine.listLocalProjects() : []) {
    const entry = entries.get(project.key) ?? { label: project.displayName, local: 0, remote: 0, path: project.cwd };
    entry.local += project.sessionCount;
    entries.set(project.key, entry);
  }
  if (direction !== 'push') {
    try {
      for (const project of (await loadRemoteForPicker(engine)).values()) {
        const entry = entries.get(project.key) ?? { label: project.metadata?.displayName ?? project.key, local: 0, remote: 0 };
        entry.remote = project.sessions.size;
        entries.set(project.key, entry);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Claude Sync: ${(err as Error).message}`);
      return undefined;
    }
  }
  if (entries.size === 0) {
    void vscode.window.showInformationMessage(t('Claude Sync: no projects found.'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    [...entries.entries()]
      .sort(([, a], [, b]) => a.label.localeCompare(b.label))
      .map(([key, e]) => ({
        label: e.label,
        description: [direction !== 'pull' ? t('{0} local', e.local) : '', direction !== 'push' ? t('{0} on GitHub', e.remote) : ''].filter(Boolean).join(' · '),
        detail: e.path ? `${key} — ${e.path}` : key,
        key,
      })),
    { title: t('Claude Sync: select projects'), canPickMany: true, matchOnDetail: true, ignoreFocusOut: true },
  );
  return picked?.map((p) => p.key);
}

async function pickSessions(direction: SyncDirection, engine: SyncEngine, storage: ClaudeStorageService): Promise<SessionRef[] | undefined> {
  type SessionPick = vscode.QuickPickItem & { ref?: SessionRef; time: number };
  const byProject = new Map<string, { label: string; items: Map<string, SessionPick> }>();

  if (direction !== 'pull') {
    for (const project of await engine.listLocalProjects()) {
      const group = byProject.get(project.key) ?? { label: project.displayName, items: new Map() };
      for (const session of await storage.listSessions(project)) {
        const info = await storage.readSessionInfo(session.mainFile);
        const time = info.lastTimestamp ?? session.mtimeMs;
        group.items.set(session.id, {
          label: `$(device-desktop) ${info.title ?? session.id.slice(0, 8)}`,
          description: `${formatDate(time)} · ${formatSize(session.totalSize)}`,
          detail: session.id,
          ref: { projectKey: project.key, sessionId: session.id },
          time,
        });
      }
      byProject.set(project.key, group);
    }
  }
  if (direction !== 'push') {
    let remote: Map<string, RemoteProject>;
    try {
      remote = await loadRemoteForPicker(engine);
    } catch (err) {
      void vscode.window.showErrorMessage(`Claude Sync: ${(err as Error).message}`);
      return undefined;
    }
    for (const project of remote.values()) {
      const group = byProject.get(project.key) ?? { label: project.metadata?.displayName ?? project.key, items: new Map() };
      for (const session of project.sessions.values()) {
        const existing = group.items.get(session.id);
        if (existing) {
          existing.label = existing.label.replace('$(device-desktop)', '$(sync)');
          continue;
        }
        const time = session.meta?.lastTimestamp ?? session.meta?.mtimeMs ?? 0;
        group.items.set(session.id, {
          label: `$(cloud) ${session.meta?.title ?? session.id.slice(0, 8)}`,
          description: `${time ? formatDate(time) + ' · ' : ''}${formatSize(session.totalSize)}`,
          detail: session.id,
          ref: { projectKey: project.key, sessionId: session.id },
          time,
        });
      }
      byProject.set(project.key, group);
    }
  }

  const items: SessionPick[] = [];
  for (const [key, group] of [...byProject.entries()].sort(([, a], [, b]) => a.label.localeCompare(b.label))) {
    if (group.items.size === 0) {
      continue;
    }
    items.push({ label: `${group.label} (${key})`, kind: vscode.QuickPickItemKind.Separator, time: 0 });
    items.push(...[...group.items.values()].sort((a, b) => b.time - a.time));
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage(t('Claude Sync: no conversations found.'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: t('Claude Sync: select conversations ($(device-desktop) local only · $(cloud) GitHub only · $(sync) both)'),
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return picked?.filter((p) => p.ref).map((p) => p.ref!);
}

/** Pergunta onde fica, nesta máquina, um projeto que só existe no remoto. */
async function askLocalPathForProject(project: RemoteProject, suggestedPath?: string): Promise<string | undefined> {
  const name = project.metadata?.displayName ?? project.key;
  type Choice = vscode.QuickPickItem & { action: 'workspace' | 'browse' | 'skip'; fsPath?: string };
  const workspaceItems: Choice[] = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => ({ label: `$(root-folder) ${f.name}`, description: f.uri.fsPath, action: 'workspace', fsPath: f.uri.fsPath }));
  if (suggestedPath && !workspaceItems.some((i) => i.fsPath === suggestedPath)) {
    workspaceItems.unshift({ label: `$(history) ${suggestedPath}`, description: t('same path used on another machine'), action: 'workspace', fsPath: suggestedPath });
  }
  const knownPaths = Object.entries(project.metadata?.knownPaths ?? {})
    .map(([host, paths]) => `${host}: ${paths.join(', ')}`)
    .join(' | ');

  const picked = await vscode.window.showQuickPick<Choice>(
    [
      ...workspaceItems,
      { label: `$(folder-opened) ${t('Select the project folder on this machine...')}`, action: 'browse' },
      { label: `$(circle-slash) ${t('Skip this project for now')}`, action: 'skip' },
    ],
    {
      title: t('Where is the project "{0}" on this machine?', name),
      placeHolder: knownPaths ? t('Paths on other machines — {0}', knownPaths) : t('Sessions will be saved in the Claude Code folder for this path'),
      ignoreFocusOut: true,
    },
  );
  if (!picked || picked.action === 'skip') {
    return undefined;
  }
  if (picked.action === 'workspace') {
    return picked.fsPath;
  }
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: t('Folder of the project "{0}" on this machine', name),
    openLabel: t('Use this folder'),
  });
  return uris?.[0]?.fsPath;
}

// =================================================================================================================
// Feedback ao usuário
// =================================================================================================================

function log(message: string): void {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function setStatus(state: 'idle' | 'syncing' | 'done' | 'error', detail?: string): void {
  if (!statusBar) {
    return;
  }
  statusBar.backgroundColor = undefined;
  switch (state) {
    case 'idle':
      statusBar.text = '$(cloud) Claude Sync';
      statusBar.tooltip = t('Claude Sync — click to sync now');
      break;
    case 'syncing':
      statusBar.text = '$(sync~spin) Claude Syncing...';
      statusBar.tooltip = t('Syncing Claude Code sessions with GitHub');
      break;
    case 'done':
      statusBar.text = '$(check) Claude Synced';
      statusBar.tooltip = `${t('Last sync: {0}', new Date().toLocaleString())}${detail ? `\n${detail}` : ''}\n${t('Click to sync again')}`;
      break;
    case 'error':
      statusBar.text = '$(error) Claude Sync';
      statusBar.tooltip = `${t('Sync failed: {0}', detail ?? '')}\n${t('Click to try again')}`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
  }
}

function labelFor(direction: SyncDirection): string {
  return direction === 'push' ? 'Push' : direction === 'pull' ? 'Pull' : t('Sync');
}

function describeScope(scope: SyncScope): string {
  switch (scope.kind) {
    case 'all':
      return t('everything');
    case 'projects':
      return t('projects {0}', scope.keys.join(', '));
    case 'sessions':
      return `${t('{0} session(s)', scope.sessions.length)}${scope.wholeProjects?.length ? ` + ${t('projects {0}', scope.wholeProjects.join(', '))}` : ''}`;
  }
}

function summarize(report: SyncReport): string {
  const parts = [
    t('{0} uploaded', report.uploaded),
    t('{0} downloaded', report.downloaded),
    report.merged ? t('{0} merged', report.merged) : '',
    report.backups.length ? t('{0} .bak backup(s)', report.backups.length) : '',
    report.skipped ? t('{0} postponed', report.skipped) : '',
  ];
  return parts.filter(Boolean).join(', ');
}

function logReport(report: SyncReport): void {
  log(t('Result: {0} project(s); {1}; {2} unchanged.', report.projects, summarize(report), report.unchanged));
  if (report.commitSha) {
    log(t('Remote commit: {0}', report.commitSha));
  }
  for (const backup of report.backups) {
    log(t('Backup created: {0}', backup));
  }
  for (const warning of report.warnings) {
    log(t('Warning: {0}', warning));
  }
}

async function showReport(report: SyncReport): Promise<void> {
  const nothing = report.uploaded + report.downloaded + report.merged === 0;
  const message = nothing ? t('Claude Sync: everything up to date ({0} file(s) checked).', report.unchanged) : `Claude Sync: ${summarize(report)}.`;
  const details = t('Show details');
  const actions = report.warnings.length || report.backups.length ? [details] : [];
  const answer = report.warnings.length
    ? await vscode.window.showWarningMessage(`${message} ${t('{0} warning(s).', report.warnings.length)}`, ...actions)
    : await vscode.window.showInformationMessage(message, ...actions);
  if (answer === details) {
    output.show();
  }
}

function handleSyncError(err: unknown, mode: 'manual' | 'auto'): void {
  const message = (err as Error)?.message ?? String(err);
  const kind = err instanceof GitHubError ? err.kind : 'other';
  log(t('ERROR ({0}): {1}', kind, message));
  if (err instanceof Error && err.stack && !(err instanceof GitHubError)) {
    log(err.stack);
  }
  setStatus('error', message);

  // No auto-sync, só notifica uma vez por tipo de erro (evita spam a cada intervalo).
  if (mode === 'auto') {
    if (lastAutoSyncErrorKind === kind) {
      return;
    }
    lastAutoSyncErrorKind = kind;
  }
  const needsConfig = kind === 'auth' || kind === 'notFound' || kind === 'forbidden';
  const configure = t('Configure');
  const showLog = t('Show log');
  const actions = needsConfig ? [configure, showLog] : [showLog];
  void vscode.window.showErrorMessage(`Claude Sync: ${message}`, ...actions).then((answer) => {
    if (answer === configure) {
      void vscode.commands.executeCommand('claudeSync.configure');
    } else if (answer === showLog) {
      output.show();
    }
  });
}
