import * as vscode from 'vscode';

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
  output = vscode.window.createOutputChannel('Claude Sync');
  context.subscriptions.push(output);

  const storage = new ClaudeStorageService();

  const host: SyncHost = {
    getGitHub: () => createGitHubService(context),
    getMappings: () => context.globalState.get<Record<string, string>>(MAPPINGS_KEY, {}),
    setMapping: async (folderName, projectKey) => {
      const mappings = { ...context.globalState.get<Record<string, string>>(MAPPINGS_KEY, {}), [folderName]: projectKey };
      await context.globalState.update(MAPPINGS_KEY, mappings);
      log(`Pasta local "${folderName}" associada ao projeto remoto "${projectKey}".`);
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
        log(`Falha ao ler o repositório remoto: ${(err as Error).message}`);
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
        void vscode.window.showInformationMessage('Claude Sync: já existe uma sincronização em andamento.');
      }
      return undefined;
    }
    if (!(await isConfigured())) {
      if (mode === 'manual') {
        const choice = await vscode.window.showWarningMessage('Claude Sync ainda não está configurado.', 'Configurar agora');
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
        log(`Auto-sync concluído com ${report.warnings.length} aviso(s).`);
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
      enabled ? `Claude Sync: auto-sync ativado (a cada ${config.get<number>('autoSyncInterval', 30)} min).` : 'Claude Sync: auto-sync desativado.',
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
      void vscode.window.showWarningMessage(`Arquivo grande (${formatSize(file.size)}); o VS Code pode não abri-lo no editor.`);
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
      log('Auto-sync desativado.');
      return;
    }
    const minutes = Math.max(1, config.get<number>('autoSyncInterval', 30));
    autoSyncTimer = setInterval(() => void runSync('sync', { kind: 'all' }, 'auto'), minutes * 60_000);
    log(`Auto-sync ativado a cada ${minutes} minuto(s).`);
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
  log(`Claude Sync ativo. Pasta do Claude Code: ${storage.projectsDir}`);
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
      repoInput ? `URL de repositório inválida: "${repoInput}". Use https://github.com/usuario/repo ou usuario/repo.` : 'Repositório GitHub não configurado.',
      'notFound',
    );
  }
  const token = await getToken(context);
  if (!token) {
    throw new GitHubError('Você não está conectado ao GitHub. Execute "Claude Sync: Configure GitHub Credentials" e escolha "Entrar com GitHub".', 'auth');
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
        label: '$(github) Entrar com GitHub',
        description: 'recomendado',
        detail: 'Login pelo navegador, como na sincronização de configurações do VS Code. Não há token para criar nem guardar.',
        method: 'login' as const,
      },
      {
        label: '$(key) Usar um token de acesso (PAT)',
        detail: 'Para quem quer um token restrito a um único repositório (fine-grained). Veja docs/GUIA-CONFIGURACAO.md.',
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
        forceNewSession: { detail: 'Entre com a outra conta do GitHub. Dica: se o navegador entrar automaticamente na conta atual, saia dela no github.com ou use uma janela anônima.' },
        clearSessionPreference: true,
      });
    } else {
      session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, GITHUB_SCOPES, { createIfNone: true, clearSessionPreference: mode === 'pick' });
    }
    loginCache.set(session.accessToken, session.account.label);
    return { token: session.accessToken, login: session.account.label, method: 'login' };
  } catch (err) {
    void vscode.window.showErrorMessage(`Claude Sync: login no GitHub não concluído (${(err as Error).message}).`);
    return undefined;
  }
}

async function askManualToken(context: vscode.ExtensionContext): Promise<GitHubAuth | undefined> {
  const existingManual = await context.secrets.get(SECRET_TOKEN_KEY);
  const tokenInput = await vscode.window.showInputBox({
    title: 'Claude Sync: token de acesso do GitHub',
    prompt: existingManual
      ? 'Novo token (deixe vazio para manter o atual). Classic: escopo "repo". Fine-grained: "Contents: Read and write".'
      : 'Crie em github.com/settings/personal-access-tokens/new com "Contents: Read and write". Fica no cofre seguro do VS Code.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (!value && !existingManual ? 'Informe o token, ou volte e escolha "Entrar com GitHub" para não precisar de token.' : undefined),
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
    prompt: `Conectado como ${auth.login}. Repositório que guardará as sessões; se não existir, será criado como privado. Use o mesmo em todas as máquinas.`,
    placeHolder: `${auth.login}/claude-code-backup`,
    value: current || `${auth.login}/claude-code-backup`,
    ignoreFocusOut: true,
    validateInput: (value) => (parseRepoInput(value) ? undefined : 'Informe usuario/repo, https://github.com/usuario/repo ou git@github.com:usuario/repo.git'),
  });
  if (repoInput === undefined) {
    return undefined;
  }
  const gh = new GitHubService(parseRepoInput(repoInput)!, auth.token, log);
  let publicAccepted = false;
  try {
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Claude Sync: validando acesso ao repositório...' }, async () => {
      try {
        const repo = await gh.getRepository();
        if (repo.permissions && repo.permissions.push === false) {
          void vscode.window.showWarningMessage(`A conta ${auth.login} não tem permissão de escrita em ${repo.full_name}; apenas Pull funcionará.`);
        }
        if (!repo.private) {
          const answer = await vscode.window.showWarningMessage(
            `O repositório ${repo.full_name} é PÚBLICO. Suas conversas com o Claude podem conter código e segredos. Deseja usá-lo mesmo assim?`,
            { modal: true },
            'Usar mesmo assim',
          );
          publicAccepted = answer === 'Usar mesmo assim';
          return publicAccepted;
        }
        return true;
      } catch (err) {
        if (err instanceof GitHubError && err.kind === 'notFound') {
          const answer = await vscode.window.showInformationMessage(
            `O repositório ${gh.fullName} não existe (ou a conta ${auth.login} não tem acesso a ele). Criar agora como repositório privado?`,
            { modal: true },
            'Criar repositório privado',
          );
          if (answer !== 'Criar repositório privado') {
            return false;
          }
          await gh.createPrivateRepository();
          log(`Repositório privado ${gh.fullName} criado.`);
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
        ? ' Tokens fine-grained não criam repositórios: crie-o no GitHub e inclua-o no token.'
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
    const answer = await vscode.window.showInformationMessage(
      'Existe um token em texto puro em "claudeSync.githubToken" no settings.json, que não é mais necessário. Removê-lo?',
      'Remover',
      'Manter',
    );
    if (answer === 'Remover') {
      await config.update('githubToken', undefined, vscode.ConfigurationTarget.Global);
    }
  }
  log(`Conectado ao GitHub como ${auth.login} (${auth.method === 'login' ? 'login do VS Code' : 'token manual'}).`);
}

/** Configuração completa: conta + repositório. */
async function configureCredentials(context: vscode.ExtensionContext): Promise<boolean> {
  const auth = await chooseAuth(context, 'Claude Sync (1/2): como acessar o GitHub?');
  if (!auth) {
    return false;
  }
  const repo = await chooseRepository(context, auth, 'Claude Sync (2/2): repositório GitHub privado');
  if (!repo) {
    return false;
  }
  await saveAuth(context, auth);
  void vscode.window.showInformationMessage(`Claude Sync configurado: ${auth.login} → ${repo}.`);
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
  const repo = await chooseRepository(context, { token, login, method }, 'Claude Sync: trocar repositório de backup');
  if (!repo) {
    return false;
  }
  void vscode.window.showInformationMessage(
    previous && parseRepoInput(previous) && `${parseRepoInput(previous)!.owner}/${parseRepoInput(previous)!.repo}`.toLowerCase() !== repo.toLowerCase()
      ? `Claude Sync agora usa ${repo}. O backup em ${previous} não foi alterado nem apagado.`
      : `Claude Sync usando ${repo}.`,
  );
  return true;
}

/** Troca a conta do GitHub (outra conta já conectada no VS Code, um login novo ou um token manual). */
async function switchAccount(context: vscode.ExtensionContext): Promise<boolean> {
  const current = await describeConnection(context);
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(account) Escolher entre as contas já conectadas no VS Code',
        detail: 'Se houver mais de uma conta do GitHub no VS Code, você escolhe qual usar.',
        mode: 'pick' as const,
      },
      {
        label: '$(sign-in) Entrar com outra conta do GitHub',
        detail: 'Abre o login no navegador. Se ele entrar sozinho na conta atual, saia dela no github.com ou use uma janela anônima.',
        mode: 'new' as const,
      },
      {
        label: '$(key) Usar um token de acesso (PAT)',
        detail: 'Token restrito a um único repositório.',
        mode: 'token' as const,
      },
    ],
    { title: 'Claude Sync: trocar conta do GitHub', placeHolder: current ? `Conexão atual: ${current}` : undefined, ignoreFocusOut: true },
  );
  if (!choice) {
    return false;
  }
  const auth = choice.mode === 'token' ? await askManualToken(context) : await signInWithGitHub(choice.mode);
  if (!auth) {
    return false;
  }
  // A nova conta pode não ter acesso ao repositório atual: confirma (ou troca) o repositório.
  const repo = await chooseRepository(context, auth, 'Claude Sync: repositório de backup para esta conta');
  if (!repo) {
    return false;
  }
  await saveAuth(context, auth);
  void vscode.window.showInformationMessage(`Claude Sync agora conectado como ${auth.login} → ${repo}.`);
  return true;
}

/** Desconecta a extensão do GitHub. Não apaga conversas locais nem o backup remoto. */
async function signOut(context: vscode.ExtensionContext): Promise<boolean> {
  if (!(await getToken(context))) {
    void vscode.window.showInformationMessage('Claude Sync não está conectado ao GitHub.');
    return false;
  }
  const current = await describeConnection(context);
  const answer = await vscode.window.showWarningMessage(
    `Desconectar o Claude Sync do GitHub${current ? ` (${current})` : ''}?`,
    {
      modal: true,
      detail:
        'A sincronização (inclusive a automática) para até você se conectar de novo. Suas conversas locais e o backup no GitHub NÃO são apagados.',
    },
    'Desconectar',
  );
  if (answer !== 'Desconectar') {
    return false;
  }
  await context.secrets.delete(SECRET_TOKEN_KEY);
  await context.globalState.update(SIGNED_OUT_KEY, true);
  loginCache.clear();
  log('Claude Sync desconectado do GitHub.');
  const next = await vscode.window.showInformationMessage(
    'Claude Sync desconectado. A conta do GitHub continua conectada ao VS Code (é usada por outros recursos); para sair dela também, use o menu Contas, no canto inferior esquerdo.',
    'Conectar outra conta',
  );
  if (next === 'Conectar outra conta') {
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
  const verb = direction === 'push' ? 'Enviar' : 'Baixar';
  const items: (vscode.QuickPickItem & { choice: ScopeChoice })[] = [
    { label: '$(globe) Tudo', description: direction === 'push' ? 'todos os projetos locais' : 'todos os projetos do repositório', choice: 'all' },
    ...(hasWorkspace ? [{ label: '$(root-folder) Projeto atual', description: 'projeto aberto neste VS Code', choice: 'current' as const }] : []),
    { label: '$(list-selection) Projetos selecionados...', choice: 'projects' },
    { label: '$(comment-discussion) Conversas específicas...', choice: 'sessions' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: `Claude Sync: ${verb} — o quê?`, ignoreFocusOut: true });
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
      { label: '$(sync) Sincronizar (bi-direcional)', direction: 'sync' as const, description: 'merge sem perdas nos dois sentidos' },
      { label: '$(cloud-upload) Enviar (Push)', direction: 'push' as const, description: 'local → GitHub' },
      { label: '$(cloud-download) Baixar (Pull)', direction: 'pull' as const, description: 'GitHub → local' },
    ],
    { title: 'Claude Sync: o que fazer com as conversas selecionadas?', ignoreFocusOut: true },
  );
  return picked?.direction;
}

async function pickCurrentProjectKeys(engine: SyncEngine): Promise<string[] | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  let selected = folders;
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { title: 'Qual pasta do workspace?', canPickMany: true, ignoreFocusOut: true },
    );
    if (!picked?.length) {
      return undefined;
    }
    selected = picked.map((p) => p.folder);
  }
  const keys: string[] = [];
  for (const folder of selected) {
    const key = await engine.resolveKeyForPath(folder.uri.fsPath);
    log(`Workspace ${folder.uri.fsPath} -> projeto remoto "${key}" (pasta Claude: ${encodeProjectPath(folder.uri.fsPath)})`);
    keys.push(key);
  }
  return keys;
}

async function loadRemoteForPicker(engine: SyncEngine): Promise<Map<string, RemoteProject>> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Claude Sync: lendo o repositório remoto...' }, async () => {
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
    void vscode.window.showInformationMessage('Claude Sync: nenhum projeto encontrado.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    [...entries.entries()]
      .sort(([, a], [, b]) => a.label.localeCompare(b.label))
      .map(([key, e]) => ({
        label: e.label,
        description: [direction !== 'pull' ? `${e.local} local` : '', direction !== 'push' ? `${e.remote} no GitHub` : ''].filter(Boolean).join(' · '),
        detail: e.path ? `${key} — ${e.path}` : key,
        key,
      })),
    { title: 'Claude Sync: selecione os projetos', canPickMany: true, matchOnDetail: true, ignoreFocusOut: true },
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
    void vscode.window.showInformationMessage('Claude Sync: nenhuma conversa encontrada.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Sync: selecione as conversas ($(device-desktop) só local · $(cloud) só GitHub · $(sync) nos dois)',
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
    workspaceItems.unshift({ label: `$(history) ${suggestedPath}`, description: 'mesmo caminho usado em outra máquina', action: 'workspace', fsPath: suggestedPath });
  }
  const knownPaths = Object.entries(project.metadata?.knownPaths ?? {})
    .map(([host, paths]) => `${host}: ${paths.join(', ')}`)
    .join(' | ');

  const picked = await vscode.window.showQuickPick<Choice>(
    [
      ...workspaceItems,
      { label: '$(folder-opened) Selecionar a pasta do projeto nesta máquina...', action: 'browse' },
      { label: '$(circle-slash) Ignorar este projeto agora', action: 'skip' },
    ],
    {
      title: `Onde fica o projeto "${name}" nesta máquina?`,
      placeHolder: knownPaths ? `Caminhos em outras máquinas — ${knownPaths}` : 'As sessões serão gravadas na pasta do Claude Code correspondente a este caminho',
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
    title: `Pasta do projeto "${name}" nesta máquina`,
    openLabel: 'Usar esta pasta',
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
      statusBar.tooltip = 'Claude Sync — clique para sincronizar agora';
      break;
    case 'syncing':
      statusBar.text = '$(sync~spin) Claude Syncing...';
      statusBar.tooltip = 'Sincronizando sessões do Claude Code com o GitHub';
      break;
    case 'done':
      statusBar.text = '$(check) Claude Synced';
      statusBar.tooltip = `Última sincronização: ${new Date().toLocaleString()}${detail ? `\n${detail}` : ''}\nClique para sincronizar novamente`;
      break;
    case 'error':
      statusBar.text = '$(error) Claude Sync';
      statusBar.tooltip = `Falha na sincronização: ${detail ?? ''}\nClique para tentar novamente`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
  }
}

function labelFor(direction: SyncDirection): string {
  return direction === 'push' ? 'Push' : direction === 'pull' ? 'Pull' : 'Sincronização';
}

function describeScope(scope: SyncScope): string {
  switch (scope.kind) {
    case 'all':
      return 'tudo';
    case 'projects':
      return `projetos ${scope.keys.join(', ')}`;
    case 'sessions':
      return `${scope.sessions.length} sessão(ões)${scope.wholeProjects?.length ? ` + projetos ${scope.wholeProjects.join(', ')}` : ''}`;
  }
}

function summarize(report: SyncReport): string {
  const parts = [
    `${report.uploaded} enviado(s)`,
    `${report.downloaded} baixado(s)`,
    report.merged ? `${report.merged} mesclado(s)` : '',
    report.backups.length ? `${report.backups.length} backup(s) .bak` : '',
    report.skipped ? `${report.skipped} adiado(s)` : '',
  ];
  return parts.filter(Boolean).join(', ');
}

function logReport(report: SyncReport): void {
  log(`Resultado: ${report.projects} projeto(s); ${summarize(report)}; ${report.unchanged} sem alteração.`);
  if (report.commitSha) {
    log(`Commit remoto: ${report.commitSha}`);
  }
  for (const backup of report.backups) {
    log(`Backup criado: ${backup}`);
  }
  for (const warning of report.warnings) {
    log(`Aviso: ${warning}`);
  }
}

async function showReport(report: SyncReport): Promise<void> {
  const nothing = report.uploaded + report.downloaded + report.merged === 0;
  const message = nothing ? `Claude Sync: tudo em dia (${report.unchanged} arquivo(s) conferidos).` : `Claude Sync: ${summarize(report)}.`;
  const actions = report.warnings.length || report.backups.length ? ['Ver detalhes'] : [];
  const answer = report.warnings.length
    ? await vscode.window.showWarningMessage(`${message} ${report.warnings.length} aviso(s).`, ...actions)
    : await vscode.window.showInformationMessage(message, ...actions);
  if (answer === 'Ver detalhes') {
    output.show();
  }
}

function handleSyncError(err: unknown, mode: 'manual' | 'auto'): void {
  const message = (err as Error)?.message ?? String(err);
  const kind = err instanceof GitHubError ? err.kind : 'other';
  log(`ERRO (${kind}): ${message}`);
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
  const actions = needsConfig ? ['Configurar', 'Ver log'] : ['Ver log'];
  void vscode.window.showErrorMessage(`Claude Sync: ${message}`, ...actions).then((answer) => {
    if (answer === 'Configurar') {
      void vscode.commands.executeCommand('claudeSync.configure');
    } else if (answer === 'Ver log') {
      output.show();
    }
  });
}
