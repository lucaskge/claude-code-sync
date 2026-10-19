import * as vscode from 'vscode';

import { ClaudeStorageService, LocalProject, LocalSession } from '../services/claudeStorageService';
import { RemoteProject, RemoteSession, SessionRef, SyncEngine } from '../services/syncEngine';

export type TreeMode = 'local' | 'remote';
type SyncStatus = 'synced' | 'localOnly' | 'remoteOnly' | 'differs' | 'unknown';

/** Nó da árvore. `ref` identifica o projeto/sessão para os comandos de push/pull/sync por item. */
export class ClaudeTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly kind: 'localProject' | 'localSession' | 'remoteProject' | 'remoteSession' | 'message',
    readonly ref?: { projectKey: string; sessionId?: string },
    readonly localProject?: LocalProject,
    readonly localSession?: LocalSession,
    readonly remoteProject?: RemoteProject,
  ) {
    super(label, collapsible);
  }
}

export class ClaudeTreeDataProvider implements vscode.TreeDataProvider<ClaudeTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ClaudeTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private forceRemote = false;

  constructor(
    private readonly mode: TreeMode,
    private readonly engine: SyncEngine,
    private readonly storage: ClaudeStorageService,
    private readonly isConfigured: () => Promise<boolean>,
  ) {}

  refresh(forceRemote = false): void {
    this.forceRemote = this.forceRemote || forceRemote;
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ClaudeTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ClaudeTreeItem): Promise<ClaudeTreeItem[]> {
    try {
      if (this.mode === 'local') {
        return element ? await this.localSessions(element) : await this.localProjects();
      }
      return element ? await this.remoteSessions(element) : await this.remoteProjects();
    } catch (err) {
      const item = new ClaudeTreeItem((err as Error).message, vscode.TreeItemCollapsibleState.None, 'message');
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      item.tooltip = (err as Error).message;
      return [item];
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Projetos locais
  // ------------------------------------------------------------------------------------------------------------

  private async localProjects(): Promise<ClaudeTreeItem[]> {
    const projects = await this.engine.listLocalProjects();
    const remote = this.engine.getCachedRemoteState();
    return projects.map((project) => {
      const item = new ClaudeTreeItem(
        project.displayName,
        vscode.TreeItemCollapsibleState.Collapsed,
        'localProject',
        { projectKey: project.key },
        project,
      );
      const inRemote = remote?.projects.has(project.key);
      item.id = `local:${project.folderName}`;
      item.contextValue = 'localProject';
      item.description = `${project.sessionCount} sessão(ões) · ${formatDate(project.lastModified)}${remote && !inRemote ? ' · não enviado' : ''}`;
      item.iconPath = new vscode.ThemeIcon(project.source === 'git' ? 'repo' : 'folder');
      item.resourceUri = vscode.Uri.file(project.dirPath);
      item.tooltip = new vscode.MarkdownString(
        [
          `**${escapeMd(project.displayName)}**`,
          '',
          `- Chave remota: \`${project.key}\` (${describeSource(project.source)})`,
          project.cwd ? `- Caminho: \`${project.cwd}\`` : undefined,
          project.gitRemote ? `- Remote Git: \`${project.gitRemote.replace(/\/\/[^/@]+@/, '//')}\`` : undefined,
          `- Pasta do Claude: \`${project.folderName}\``,
        ]
          .filter((l) => l !== undefined)
          .join('\n'),
      );
      return item;
    });
  }

  private async localSessions(element: ClaudeTreeItem): Promise<ClaudeTreeItem[]> {
    if (element.kind !== 'localProject' || !element.localProject) {
      return [];
    }
    const project = element.localProject;
    const sessions = await this.storage.listSessions(project);
    const remoteProject = this.engine.getCachedRemoteState()?.projects.get(project.key);
    const remoteAvailable = !!this.engine.getCachedRemoteState();

    const items: ClaudeTreeItem[] = [];
    for (const session of sessions) {
      const info = await this.storage.readSessionInfo(session.mainFile);
      const status = remoteAvailable ? await this.compareLocal(session, remoteProject?.sessions.get(session.id)) : 'unknown';
      const item = new ClaudeTreeItem(
        info.title ?? session.id.slice(0, 8),
        vscode.TreeItemCollapsibleState.None,
        'localSession',
        { projectKey: project.key, sessionId: session.id },
        project,
        session,
      );
      item.id = `local:${project.folderName}:${session.id}`;
      item.contextValue = 'localSession';
      item.description = `${formatDate(info.lastTimestamp ?? session.mtimeMs)} · ${formatSize(session.totalSize)}`;
      item.iconPath = statusIcon(status);
      item.tooltip = new vscode.MarkdownString(
        [
          `**${escapeMd(info.title ?? '(sem título)')}**`,
          '',
          `- Sessão: \`${session.id}\``,
          `- Última alteração: ${formatDate(session.mtimeMs)}`,
          info.firstTimestamp ? `- Início: ${formatDate(info.firstTimestamp)}` : undefined,
          `- Tamanho: ${formatSize(session.totalSize)} (${1 + session.extraFiles.length} arquivo(s))`,
          `- Status: ${describeStatus(status)}`,
        ]
          .filter((l) => l !== undefined)
          .join('\n'),
      );
      items.push(item);
    }
    return items;
  }

  private async compareLocal(session: LocalSession, remote: RemoteSession | undefined): Promise<SyncStatus> {
    if (!remote) {
      return 'localOnly';
    }
    const files = [session.mainFile, ...session.extraFiles];
    if (files.length !== remote.files.size) {
      return 'differs';
    }
    for (const file of files) {
      const remoteFile = remote.files.get(file.relPath);
      if (!remoteFile || remoteFile.size !== file.size || remoteFile.sha !== (await this.storage.fileSha(file))) {
        return 'differs';
      }
    }
    return 'synced';
  }

  // ------------------------------------------------------------------------------------------------------------
  // Projetos remotos
  // ------------------------------------------------------------------------------------------------------------

  private async remoteProjects(): Promise<ClaudeTreeItem[]> {
    if (!(await this.isConfigured())) {
      return [];
    }
    const force = this.forceRemote;
    this.forceRemote = false;
    const state = await this.engine.getRemoteState(force);
    const localKeys = new Set((await this.engine.listLocalProjects()).map((p) => p.key));

    const projects = [...state.projects.values()].sort((a, b) => (a.metadata?.displayName ?? a.key).localeCompare(b.metadata?.displayName ?? b.key));
    if (projects.length === 0) {
      const item = new ClaudeTreeItem(`Nenhum projeto em ${state.repo} ainda`, vscode.TreeItemCollapsibleState.None, 'message');
      item.iconPath = new vscode.ThemeIcon('info');
      item.description = 'use Push para enviar';
      return [item];
    }
    return projects.map((project) => {
      const item = new ClaudeTreeItem(
        project.metadata?.displayName ?? project.key,
        vscode.TreeItemCollapsibleState.Collapsed,
        'remoteProject',
        { projectKey: project.key },
        undefined,
        undefined,
        project,
      );
      item.id = `remote:${project.key}`;
      item.contextValue = 'remoteProject';
      item.description = `${project.sessions.size} sessão(ões)${localKeys.has(project.key) ? '' : ' · não existe nesta máquina'}`;
      item.iconPath = new vscode.ThemeIcon(localKeys.has(project.key) ? 'cloud' : 'cloud-download');
      const machines = Object.entries(project.metadata?.knownPaths ?? {}).map(([host, paths]) => `- ${escapeMd(host)}: ${paths.map((p) => `\`${p}\``).join(', ')}`);
      item.tooltip = new vscode.MarkdownString(
        [
          `**${escapeMd(project.metadata?.displayName ?? project.key)}**`,
          '',
          `- Pasta remota: \`repos/${project.key}\``,
          project.metadata?.gitRemote ? `- Remote Git: \`${project.metadata.gitRemote}\`` : undefined,
          project.metadata?.updatedAt ? `- Atualizado em: ${formatDate(Date.parse(project.metadata.updatedAt))}` : undefined,
          machines.length ? '\nMáquinas:' : undefined,
          ...machines,
        ]
          .filter((l) => l !== undefined)
          .join('\n'),
      );
      return item;
    });
  }

  private async remoteSessions(element: ClaudeTreeItem): Promise<ClaudeTreeItem[]> {
    if (element.kind !== 'remoteProject' || !element.remoteProject) {
      return [];
    }
    const project = element.remoteProject;
    const localSessions = new Map<string, LocalSession>();
    for (const local of (await this.engine.listLocalProjects()).filter((p) => p.key === project.key)) {
      for (const session of await this.storage.listSessions(local)) {
        localSessions.set(session.id, session);
      }
    }

    const sessions = [...project.sessions.values()].sort((a, b) => sessionTime(b) - sessionTime(a));
    const items: ClaudeTreeItem[] = [];
    for (const session of sessions) {
      const local = localSessions.get(session.id);
      const status: SyncStatus = local ? await this.compareLocal(local, session) : 'remoteOnly';
      const meta = session.meta;
      const item = new ClaudeTreeItem(
        meta?.title ?? session.id.slice(0, 8),
        vscode.TreeItemCollapsibleState.None,
        'remoteSession',
        { projectKey: project.key, sessionId: session.id },
        undefined,
        local,
        project,
      );
      item.id = `remote:${project.key}:${session.id}`;
      item.contextValue = 'remoteSession';
      item.description = `${sessionTime(session) ? formatDate(sessionTime(session)) + ' · ' : ''}${formatSize(session.totalSize)}`;
      item.iconPath = statusIcon(status);
      item.tooltip = new vscode.MarkdownString(
        [
          `**${escapeMd(meta?.title ?? '(sem título)')}**`,
          '',
          `- Sessão: \`${session.id}\``,
          meta?.lastTimestamp ? `- Último evento: ${formatDate(meta.lastTimestamp)}` : undefined,
          meta?.updatedBy ? `- Enviada por: ${escapeMd(meta.updatedBy)}` : undefined,
          `- Tamanho: ${formatSize(session.totalSize)} (${session.files.size} arquivo(s))`,
          `- Status: ${describeStatus(status)}`,
        ]
          .filter((l) => l !== undefined)
          .join('\n'),
      );
      items.push(item);
    }
    return items;
  }
}

/** Converte os itens selecionados na árvore em referências de sessão/projeto para o SyncEngine. */
export function itemsToScope(items: ClaudeTreeItem[]): { projectKeys: string[]; sessions: SessionRef[] } {
  const projectKeys = new Set<string>();
  const sessions: SessionRef[] = [];
  for (const item of items) {
    if (!item.ref) {
      continue;
    }
    if (item.ref.sessionId) {
      sessions.push({ projectKey: item.ref.projectKey, sessionId: item.ref.sessionId });
    } else {
      projectKeys.add(item.ref.projectKey);
    }
  }
  // Sessões de projetos já selecionados inteiros são redundantes.
  return { projectKeys: [...projectKeys], sessions: sessions.filter((s) => !projectKeys.has(s.projectKey)) };
}

function sessionTime(session: RemoteSession): number {
  return session.meta?.lastTimestamp ?? session.meta?.mtimeMs ?? 0;
}

function statusIcon(status: SyncStatus): vscode.ThemeIcon {
  switch (status) {
    case 'synced':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'localOnly':
      return new vscode.ThemeIcon('cloud-upload', new vscode.ThemeColor('charts.yellow'));
    case 'remoteOnly':
      return new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('charts.blue'));
    case 'differs':
      return new vscode.ThemeIcon('diff', new vscode.ThemeColor('charts.orange'));
    default:
      return new vscode.ThemeIcon('comment-discussion');
  }
}

function describeStatus(status: SyncStatus): string {
  switch (status) {
    case 'synced':
      return 'sincronizada';
    case 'localOnly':
      return 'somente local (ainda não enviada)';
    case 'remoteOnly':
      return 'somente no GitHub (não existe nesta máquina)';
    case 'differs':
      return 'diferente entre local e GitHub';
    default:
      return 'desconhecido (atualize a visão remota)';
  }
}

function describeSource(source: LocalProject['source']): string {
  switch (source) {
    case 'git':
      return 'pelo remote Git';
    case 'mapping':
      return 'associação manual';
    case 'cwd':
      return 'pelo nome da pasta, sem remote Git';
    default:
      return 'pelo nome da pasta do Claude';
  }
}

export function formatDate(ms: number | undefined): string {
  if (!ms) {
    return '—';
  }
  return new Date(ms).toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
}
