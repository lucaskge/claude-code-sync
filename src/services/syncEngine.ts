import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ClaudeStorageService,
  LocalFile,
  LocalProject,
  LocalSession,
  encodeProjectPath,
  gitBlobSha,
  lineTimestamp,
  safeParse,
} from './claudeStorageService';
import { CHUNK_MANIFEST, ChunkManifest, chunkDirFor, decodeChunked, encodeChunked, parseChunkPath, parseManifest, shouldChunk } from './chunkedStorage';
import { FileChange, GitHubError, GitHubService, MAX_REMOTE_FILE_BYTES, RemoteFile, RemoteSnapshot, runWithConcurrency } from './githubService';

/**
 * Motor de sincronização.
 *
 * Layout remoto:
 *   repos/<projectKey>/<sessionId>.jsonl
 *   repos/<projectKey>/<sessionId>/<subpastas>/<arquivos>
 *   repos/<projectKey>/metadata.json
 *
 * Regra de ouro: nenhuma sessão local é apagada ou truncada.
 *   - só no remoto  -> baixa (pull/sync)
 *   - só no local   -> mantém; envia (push/sync)
 *   - nos dois      -> .jsonl: união das linhas (eventos) dos dois lados, ordenada por timestamp;
 *                      se nenhum lado tiver linhas exclusivas o maior vence; se ambos tiverem, gera
 *                      "<arquivo>.<data>.bak" local antes de gravar o resultado mesclado.
 *                      outros arquivos: vence o mais recente (mtime), com .bak local se o local for substituído.
 * O remoto nunca perde dados de fato: cada sincronização é um commit, o histórico Git preserva versões anteriores.
 */

export type SyncDirection = 'push' | 'pull' | 'sync';

export interface SessionRef {
  projectKey: string;
  sessionId: string;
}

export type SyncScope =
  | { kind: 'all' }
  | { kind: 'projects'; keys: string[] }
  /** Sessões específicas; `wholeProjects` permite incluir projetos inteiros na mesma seleção. */
  | { kind: 'sessions'; sessions: SessionRef[]; wholeProjects?: string[] };

export interface SyncOptions {
  direction: SyncDirection;
  scope: SyncScope;
  /** Permite perguntar ao usuário (ex: onde salvar um projeto remoto que não existe nesta máquina). */
  interactive: boolean;
  onProgress?: (message: string) => void;
}

export interface SyncReport {
  direction: SyncDirection;
  projects: number;
  uploaded: number;
  downloaded: number;
  merged: number;
  unchanged: number;
  skipped: number;
  backups: string[];
  warnings: string[];
  commitSha?: string;
}

export interface RemoteFileMeta {
  size: number;
  mtimeMs: number;
  sha: string;
}

export interface SessionMeta {
  title?: string;
  firstTimestamp?: number;
  lastTimestamp?: number;
  size: number;
  mtimeMs: number;
  updatedBy?: string;
  files: Record<string, RemoteFileMeta>;
}

export interface ProjectMetadata {
  version: 1;
  key: string;
  displayName: string;
  gitRemote?: string;
  /** Caminhos do projeto em cada máquina, usados para mapear automaticamente o projeto num pull. */
  knownPaths: Record<string, string[]>;
  updatedAt: string;
  sessions: Record<string, SessionMeta>;
}

export interface RemoteSession {
  id: string;
  files: Map<string, RemoteFile>;
  meta?: SessionMeta;
  totalSize: number;
}

export interface RemoteProject {
  key: string;
  metadata?: ProjectMetadata;
  sessions: Map<string, RemoteSession>;
}

export interface RemoteState {
  repo: string;
  snapshot: RemoteSnapshot;
  projects: Map<string, RemoteProject>;
  fetchedAt: number;
}

export interface SyncHost {
  /** Retorna o cliente GitHub configurado ou lança erro com mensagem amigável. */
  getGitHub(): Promise<GitHubService>;
  getMappings(): Record<string, string>;
  setMapping(folderName: string, projectKey: string): Promise<void>;
  workspacePaths(): string[];
  /**
   * Pergunta ao usuário o caminho local do projeto (somente em modo interativo). Retorna undefined para pular.
   * `suggestedPath` é um caminho conhecido de outra máquina que também existe nesta; só é usado se o usuário confirmar.
   */
  askLocalPathForProject?(project: RemoteProject, suggestedPath?: string): Promise<string | undefined>;
  /** true se o usuário aceitou explicitamente enviar conversas para este repositório público. */
  isPublicRepoAllowed?(fullName: string): boolean;
  log(message: string): void;
}

export class SyncBusyError extends Error {
  constructor() {
    super('Já existe uma sincronização em andamento.');
  }
}

const METADATA_FILE = 'metadata.json';
const REMOTE_ROOT = 'repos/';
/** Arquivos modificados há menos que isso são considerados "em uso" pelo Claude Code e não são sobrescritos. */
const ACTIVE_WINDOW_MS = 10_000;
const MAX_CONFLICT_RETRIES = 3;

export class SyncEngine {
  private running = false;
  private remoteCache?: RemoteState;
  private readonly metadataBlobCache = new Map<string, ProjectMetadata | undefined>();
  private readonly manifestCache = new Map<string, ChunkManifest>();
  private readonly listeners = new Set<() => void>();
  private readonly hostname = os.hostname();

  constructor(
    private readonly storage: ClaudeStorageService,
    private readonly host: SyncHost,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private fireChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignora erros de listeners
      }
    }
  }

  invalidateRemote(): void {
    this.remoteCache = undefined;
    this.fireChanged();
  }

  getCachedRemoteState(): RemoteState | undefined {
    return this.remoteCache;
  }

  async getRemoteState(force = false): Promise<RemoteState> {
    const gh = await this.host.getGitHub();
    if (!force && this.remoteCache && this.remoteCache.repo === gh.fullName) {
      return this.remoteCache;
    }
    this.remoteCache = await this.loadRemoteState(gh);
    return this.remoteCache;
  }

  async listLocalProjects(): Promise<LocalProject[]> {
    return this.storage.listProjects(this.host.getMappings());
  }

  /** Chave remota do projeto aberto num caminho local (ex: workspace atual). */
  async resolveKeyForPath(projectPath: string): Promise<string> {
    const folderName = encodeProjectPath(projectPath);
    const identity = await this.storage.resolveIdentity(projectPath, folderName, this.host.getMappings()[folderName]);
    return identity.key;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Execução
  // ------------------------------------------------------------------------------------------------------------

  async run(options: SyncOptions): Promise<SyncReport> {
    if (this.running) {
      throw new SyncBusyError();
    }
    this.running = true;
    try {
      const gh = await this.host.getGitHub();
      for (let attempt = 1; ; attempt++) {
        try {
          const report = await this.runOnce(gh, options);
          return report;
        } catch (err) {
          if (err instanceof GitHubError && err.kind === 'conflict' && attempt < MAX_CONFLICT_RETRIES) {
            this.host.log(`Conflito de commit (tentativa ${attempt}); recarregando o estado remoto e mesclando de novo...`);
            continue;
          }
          throw err;
        }
      }
    } finally {
      this.running = false;
      this.fireChanged();
    }
  }

  private async runOnce(gh: GitHubService, options: SyncOptions): Promise<SyncReport> {
    const { direction } = options;
    const progress = (msg: string) => {
      options.onProgress?.(msg);
      this.host.log(msg);
    };
    const report: SyncReport = {
      direction,
      projects: 0,
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      unchanged: 0,
      skipped: 0,
      backups: [],
      warnings: [],
    };

    progress(`Lendo estado remoto de ${gh.fullName}...`);
    let remote = await this.loadRemoteState(gh);
    if (remote.snapshot.empty) {
      if (direction === 'pull') {
        this.remoteCache = remote;
        report.warnings.push('O repositório remoto ainda está vazio — nada para baixar.');
        return report;
      }
      progress('Repositório vazio; criando commit inicial...');
      await gh.initializeRepository();
      remote = await this.loadRemoteState(gh);
    }

    progress('Lendo sessões locais...');
    const localProjects = await this.listLocalProjects();
    const keys = this.keysInScope(options.scope, direction, localProjects, remote);
    const scope = options.scope;
    const sessionFilter =
      scope.kind === 'sessions'
        ? (key: string, id: string) => (scope.wholeProjects ?? []).includes(key) || scope.sessions.some((s) => s.projectKey === key && s.sessionId === id)
        : undefined;

    const uploads = new Map<string, Buffer>();
    const metadataUpdates = new Map<string, ProjectMetadata>();

    for (const key of keys) {
      report.projects++;
      progress(`Projeto ${key}...`);
      const ctx = new ProjectContext(key, localProjects.filter((p) => p.key === key), remote.projects.get(key));
      await this.syncProject(gh, ctx, options, report, uploads, sessionFilter);

      if (direction !== 'pull') {
        const metadata = await this.buildMetadata(ctx, uploads);
        const previous = ctx.remote?.metadata;
        if (!previous || stableStringify({ ...metadata, updatedAt: '' }) !== stableStringify({ ...previous, updatedAt: '' })) {
          metadataUpdates.set(key, metadata);
        }
      }
    }

    const changes = this.buildChanges(uploads, remote.snapshot);
    for (const [key, metadata] of metadataUpdates) {
      changes.push({ path: `${REMOTE_ROOT}${key}/${METADATA_FILE}`, content: Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8') });
    }

    if (changes.length > 0) {
      // Confere a visibilidade a cada envio: o repositório pode ter sido tornado público depois da configuração.
      const repo = await gh.getRepository();
      if (!repo.private && !this.host.isPublicRepoAllowed?.(repo.full_name.toLowerCase())) {
        throw new GitHubError(
          `O repositório ${repo.full_name} é PÚBLICO. Envio bloqueado para não expor suas conversas; torne-o privado ou reconfigure o repositório.`,
          'forbidden',
        );
      }
      progress(`Enviando ${uploads.size} arquivo(s) para o GitHub...`);
      const message = `Claude Sync (${direction}) de ${this.hostname}: ${uploads.size} arquivo(s), ${metadataUpdates.size} índice(s)`;
      const result = await gh.commitFiles(remote.snapshot, changes, message, (done, total) => {
        options.onProgress?.(`Enviando arquivos (${done}/${total})...`);
      });
      for (const failure of result.failed) {
        report.uploaded = Math.max(0, report.uploaded - 1);
        report.skipped++;
        report.warnings.push(`${failure.group}: não enviado — ${failure.message}`);
      }
      if (result.sha) {
        report.commitSha = result.sha;
        progress(`Commit ${result.sha.slice(0, 7)} criado.`);
      }
      this.remoteCache = undefined;
    } else {
      this.remoteCache = remote;
    }
    return report;
  }

  private keysInScope(scope: SyncScope, direction: SyncDirection, locals: LocalProject[], remote: RemoteState): string[] {
    const localKeys = new Set(locals.map((p) => p.key));
    const remoteKeys = new Set(remote.projects.keys());
    let keys: Set<string>;
    switch (scope.kind) {
      case 'all':
        keys = direction === 'push' ? localKeys : direction === 'pull' ? remoteKeys : new Set([...localKeys, ...remoteKeys]);
        break;
      case 'projects':
        keys = new Set(scope.keys);
        break;
      case 'sessions':
        keys = new Set([...scope.sessions.map((s) => s.projectKey), ...(scope.wholeProjects ?? [])]);
        break;
    }
    return [...keys].sort();
  }

  private async syncProject(
    gh: GitHubService,
    ctx: ProjectContext,
    options: SyncOptions,
    report: SyncReport,
    uploads: Map<string, Buffer>,
    sessionFilter?: (projectKey: string, sessionId: string) => boolean,
  ): Promise<void> {
    const { direction } = options;
    const localSessions = new Map<string, LocalSession>();
    for (const project of ctx.locals) {
      for (const session of await this.storage.listSessions(project)) {
        const existing = localSessions.get(session.id);
        if (!existing || session.mtimeMs > existing.mtimeMs) {
          localSessions.set(session.id, session);
        }
      }
    }
    ctx.localSessions = localSessions;

    const ids = new Set<string>();
    if (direction !== 'pull') {
      localSessions.forEach((_, id) => ids.add(id));
    }
    if (direction !== 'push') {
      ctx.remote?.sessions.forEach((_, id) => ids.add(id));
    }

    for (const id of [...ids].sort()) {
      if (sessionFilter && !sessionFilter(ctx.key, id)) {
        continue;
      }
      const local = localSessions.get(id);
      const remoteSession = ctx.remote?.sessions.get(id);

      const files = new Map<string, { local?: LocalFile; remote?: RemoteFile }>();
      if (local) {
        for (const f of [local.mainFile, ...local.extraFiles]) {
          files.set(f.relPath, { local: f });
        }
      }
      if (remoteSession) {
        for (const [relPath, rf] of remoteSession.files) {
          files.set(relPath, { ...files.get(relPath), remote: rf });
        }
      }
      // Arquivo principal primeiro, para que o título/metadados reflitam o resultado final.
      const rank = (relPath: string) => (relPath === `${id}.jsonl` ? 0 : 1);
      const ordered = [...files.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
      for (const [relPath, pair] of ordered) {
        try {
          await this.syncFile(gh, ctx, id, relPath, pair.local, pair.remote, options, report, uploads);
        } catch (err) {
          if (err instanceof GitHubError && err.kind !== 'other') {
            throw err;
          }
          report.skipped++;
          report.warnings.push(`${ctx.key}/${relPath}: ${(err as Error).message}`);
        }
      }
    }
  }

  private async syncFile(
    gh: GitHubService,
    ctx: ProjectContext,
    sessionId: string,
    relPath: string,
    local: LocalFile | undefined,
    remote: RemoteFile | undefined,
    options: SyncOptions,
    report: SyncReport,
    uploads: Map<string, Buffer>,
  ): Promise<void> {
    const { direction } = options;
    const remotePath = `${REMOTE_ROOT}${ctx.key}/${relPath}`;
    const canPush = direction !== 'pull';
    const canPull = direction !== 'push';

    // ---- Só local ------------------------------------------------------------------------------------------
    if (local && !remote) {
      if (!canPush) {
        return;
      }
      const { content } = await this.storage.readFile(local.absPath);
      this.queueUpload(uploads, remotePath, content, report);
      return;
    }

    // ---- Só remoto -----------------------------------------------------------------------------------------
    if (!local && remote) {
      if (!canPull) {
        return;
      }
      const dir = await this.resolveDownloadDir(ctx, sessionId, options);
      if (!dir) {
        report.skipped++;
        return;
      }
      const content = await this.readRemote(gh, remote);
      const absPath = safeJoin(dir, relPath);
      const written = await this.storage.writeFileSafe(absPath, content, null);
      if (written) {
        report.downloaded++;
      } else {
        report.skipped++;
        report.warnings.push(`${ctx.key}/${relPath}: arquivo surgiu localmente durante a sincronização; será mesclado na próxima.`);
      }
      return;
    }

    if (!local || !remote) {
      return;
    }

    // ---- Nos dois lados ------------------------------------------------------------------------------------
    const localRead = await this.storage.readFile(local.absPath);
    if (gitBlobSha(localRead.content) === remote.sha) {
      report.unchanged++;
      return;
    }
    const remoteContent = await this.readRemote(gh, remote);

    let decision: Decision;
    if (relPath.endsWith('.jsonl')) {
      const merge = mergeJsonl(localRead.content, remoteContent);
      decision =
        merge.kind === 'local'
          ? { kind: 'keepLocal' }
          : merge.kind === 'remote'
            ? { kind: 'takeRemote', content: remoteContent, backup: merge.reason === 'equivalent' }
            : { kind: 'merged', content: merge.content };
    } else {
      const remoteMtime = ctx.remote?.sessions.get(sessionId)?.meta?.files[relPath]?.mtimeMs;
      decision = remoteMtime !== undefined && remoteMtime > localRead.mtimeMs ? { kind: 'takeRemote', content: remoteContent, backup: true } : { kind: 'keepLocal' };
    }

    switch (decision.kind) {
      case 'keepLocal':
        if (canPush) {
          this.queueUpload(uploads, remotePath, localRead.content, report);
        } else {
          report.unchanged++;
          this.host.log(`${ctx.key}/${relPath}: versão local já contém tudo do remoto (mantida).`);
        }
        return;

      case 'takeRemote':
        if (!canPull) {
          report.skipped++;
          report.warnings.push(`${ctx.key}/${relPath}: o remoto tem eventos mais novos; use Pull ou Sync para trazê-los.`);
          return;
        }
        if (await this.writeLocal(local, localRead, decision.content, decision.backup, report, `${ctx.key}/${relPath}`)) {
          report.downloaded++;
        }
        return;

      case 'merged':
        report.merged++;
        if (canPull) {
          await this.writeLocal(local, localRead, decision.content, true, report, `${ctx.key}/${relPath}`);
        }
        if (canPush) {
          this.queueUpload(uploads, remotePath, decision.content, report);
        }
        return;
    }
  }

  private queueUpload(uploads: Map<string, Buffer>, remotePath: string, content: Buffer, report: SyncReport): void {
    if (content.length > MAX_REMOTE_FILE_BYTES) {
      report.skipped++;
      report.warnings.push(`${remotePath}: ${(content.length / 1024 / 1024).toFixed(1)} MB é grande demais para sincronizar (limite: 1 GB); não enviado.`);
      return;
    }
    uploads.set(remotePath, content);
    report.uploaded++;
  }

  /** Sobrescreve um arquivo local com segurança: nunca durante escrita ativa, com backup opcional e checagem de corrida. */
  private async writeLocal(
    local: LocalFile,
    read: { size: number; mtimeMs: number },
    content: Buffer,
    backup: boolean,
    report: SyncReport,
    label: string,
  ): Promise<boolean> {
    if (Date.now() - read.mtimeMs < ACTIVE_WINDOW_MS) {
      report.skipped++;
      report.warnings.push(`${label}: sessão em uso agora pelo Claude Code; atualização local adiada para a próxima sincronização.`);
      return false;
    }
    const backupPath = backup ? await this.storage.backupFile(local.absPath) : undefined;
    const ok = await this.storage.writeFileSafe(local.absPath, content, { size: read.size, mtimeMs: read.mtimeMs });
    if (!ok) {
      if (backupPath) {
        await fs.promises.rm(backupPath, { force: true });
      }
      report.skipped++;
      report.warnings.push(`${label}: arquivo mudou durante a sincronização; atualização local adiada.`);
      return false;
    }
    if (backupPath) {
      report.backups.push(backupPath);
    }
    return true;
  }

  /** Decide em qual pasta local (~/.claude/projects/<pasta>) gravar sessões que só existem no remoto. */
  private async resolveDownloadDir(ctx: ProjectContext, sessionId: string, options: SyncOptions): Promise<string | undefined> {
    const existing = ctx.localSessions.get(sessionId);
    if (existing) {
      return existing.projectDir;
    }
    if (ctx.downloadDir !== undefined) {
      return ctx.downloadDir || undefined;
    }

    const projectsDir = this.storage.projectsDir;
    const mappings = this.host.getMappings();
    let folderName: string | undefined;

    // 1) Pasta já associada manualmente ao projeto.
    folderName = Object.keys(mappings).find((folder) => mappings[folder] === ctx.key);

    // 2) Pasta local já existente com a mesma chave (a mais recente; preferindo a do workspace aberto).
    if (!folderName && ctx.locals.length > 0) {
      const workspaceFolders = new Set(this.host.workspacePaths().map((p) => encodeProjectPath(p)));
      folderName = (ctx.locals.find((p) => workspaceFolders.has(p.folderName)) ?? ctx.locals[0]).folderName;
    }

    // 3) Workspace aberto que resolve para a mesma chave.
    if (!folderName) {
      for (const ws of this.host.workspacePaths()) {
        if ((await this.resolveKeyForPath(ws)) === ctx.key) {
          folderName = encodeProjectPath(ws);
          break;
        }
      }
    }

    // 4) Pergunta ao usuário. Um caminho conhecido de outra máquina que também existe nesta (ex: mesmo caminho em
    //    duas máquinas Linux) vira apenas sugestão: os caminhos vêm do remoto e não devem decidir sozinhos onde gravar.
    if (!folderName && options.interactive && this.host.askLocalPathForProject && ctx.remote) {
      let suggested: string | undefined;
      if (ctx.remote.metadata) {
        const paths = [...(ctx.remote.metadata.knownPaths[this.hostname] ?? []), ...Object.values(ctx.remote.metadata.knownPaths).flat()];
        suggested = paths.find((p) => isAbsoluteForThisOs(p) && isDirectory(p));
      }
      const chosen = await this.host.askLocalPathForProject(ctx.remote, suggested);
      if (chosen) {
        folderName = encodeProjectPath(chosen);
      }
    }

    if (!folderName) {
      ctx.downloadDir = '';
      this.host.log(`Projeto ${ctx.key} não tem pasta local associada nesta máquina; sessões remotas ignoradas.`);
      return undefined;
    }

    if (mappings[folderName] !== ctx.key && !ctx.locals.some((p) => p.folderName === folderName)) {
      await this.host.setMapping(folderName, ctx.key);
    }
    ctx.downloadDir = path.join(projectsDir, folderName);
    return ctx.downloadDir;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Metadados
  // ------------------------------------------------------------------------------------------------------------

  /** Reconstrói metadata.json do projeto refletindo o conteúdo remoto após este commit. */
  private async buildMetadata(ctx: ProjectContext, uploads: Map<string, Buffer>): Promise<ProjectMetadata> {
    const previous = ctx.remote?.metadata;
    const primary = ctx.locals[0];
    const knownPaths: Record<string, string[]> = { ...(previous?.knownPaths ?? {}) };
    const localPaths = ctx.locals.map((p) => p.cwd).filter((p): p is string => !!p);
    if (localPaths.length) {
      knownPaths[this.hostname] = [...new Set([...(knownPaths[this.hostname] ?? []), ...localPaths])].sort();
    }

    const sessions: Record<string, SessionMeta> = {};
    const sessionIds = new Set<string>([...(ctx.remote?.sessions.keys() ?? []), ...ctx.localSessions.keys()]);
    for (const id of sessionIds) {
      const prevMeta = previous?.sessions[id];
      const remoteSession = ctx.remote?.sessions.get(id);
      const local = ctx.localSessions.get(id);
      const files: Record<string, RemoteFileMeta> = {};
      let touched = false;

      const relPaths = new Set<string>([...(remoteSession?.files.keys() ?? [])]);
      for (const f of local ? [local.mainFile, ...local.extraFiles] : []) {
        if (uploads.has(`${REMOTE_ROOT}${ctx.key}/${f.relPath}`)) {
          relPaths.add(f.relPath);
        }
      }
      for (const relPath of relPaths) {
        const uploaded = uploads.get(`${REMOTE_ROOT}${ctx.key}/${relPath}`);
        const localFile = local && [local.mainFile, ...local.extraFiles].find((f) => f.relPath === relPath);
        if (uploaded) {
          touched = true;
          files[relPath] = { size: uploaded.length, sha: gitBlobSha(uploaded), mtimeMs: Math.round(localFile?.mtimeMs ?? Date.now()) };
        } else {
          const rf = remoteSession?.files.get(relPath);
          if (rf) {
            files[relPath] = { size: rf.size, sha: rf.sha, mtimeMs: prevMeta?.files[relPath]?.mtimeMs ?? 0 };
          }
        }
      }
      if (Object.keys(files).length === 0) {
        continue;
      }

      let info = { title: prevMeta?.title, firstTimestamp: prevMeta?.firstTimestamp, lastTimestamp: prevMeta?.lastTimestamp };
      if (local && (touched || !prevMeta)) {
        const fresh = await this.storage.statFile(local.mainFile.absPath);
        const sessionInfo = await this.storage.readSessionInfo({ ...local.mainFile, ...(fresh ? { size: fresh.size, mtimeMs: fresh.mtimeMs } : {}) });
        info = { title: sessionInfo.title ?? info.title, firstTimestamp: sessionInfo.firstTimestamp, lastTimestamp: sessionInfo.lastTimestamp };
      }
      const fileList = Object.values(files);
      sessions[id] = {
        ...stripUndefined(info),
        size: fileList.reduce((sum, f) => sum + f.size, 0),
        mtimeMs: Math.max(...fileList.map((f) => f.mtimeMs)),
        updatedBy: touched ? this.hostname : prevMeta?.updatedBy,
        files: sortObject(files),
      };
    }

    return {
      version: 1,
      key: ctx.key,
      displayName: primary?.displayName ?? previous?.displayName ?? ctx.key,
      ...(primary?.gitRemote || previous?.gitRemote ? { gitRemote: redactCredentials(primary?.gitRemote ?? previous?.gitRemote ?? '') } : {}),
      knownPaths: sortObject(knownPaths),
      updatedAt: new Date().toISOString(),
      sessions: sortObject(sessions),
    };
  }

  /** Lê o conteúdo de um arquivo remoto, remontando-o se estiver dividido em partes. */
  private async readRemote(gh: GitHubService, file: RemoteFile): Promise<Buffer> {
    if (file.size > MAX_REMOTE_FILE_BYTES) {
      throw new Error(`arquivo remoto grande demais (${(file.size / 1024 / 1024).toFixed(1)} MB; limite: 1 GB)`);
    }
    if (!file.chunked) {
      return gh.getBlob(file.sha);
    }
    const dir = chunkDirFor(file.path);
    const parts: Buffer[] = [];
    for (const name of file.chunked.manifest.parts) {
      const sha = file.chunked.partShas.get(dir + name);
      if (!sha) {
        throw new Error(`parte ${name} ausente no remoto`);
      }
      parts.push(await gh.getBlob(sha));
    }
    return decodeChunked(file.chunked.manifest, parts);
  }

  /**
   * Converte os uploads lógicos (caminho -> conteúdo) em alterações do repositório: arquivos grandes viram
   * manifesto + partes comprimidas; versões anteriores no formato oposto (inteiro/dividido) são removidas no
   * mesmo commit, no mesmo grupo — se algo falhar, nada daquele arquivo muda no remoto.
   */
  private buildChanges(uploads: Map<string, Buffer>, snapshot: RemoteSnapshot): FileChange[] {
    const changes: FileChange[] = [];
    for (const [remotePath, content] of uploads) {
      const dir = chunkDirFor(remotePath);
      const existingChunkPaths = [...snapshot.files.keys()].filter((p) => p.startsWith(dir));
      if (shouldChunk(content)) {
        const { files } = encodeChunked(remotePath, content);
        const newPaths = new Set(files.map((f) => f.path));
        for (const file of files) {
          // Partes idênticas às que já estão no remoto não precisam ser reenviadas.
          if (snapshot.files.get(file.path)?.sha !== gitBlobSha(file.content)) {
            changes.push({ path: file.path, content: file.content, group: remotePath });
          }
        }
        for (const old of existingChunkPaths.filter((p) => !newPaths.has(p))) {
          changes.push({ path: old, delete: true, group: remotePath });
        }
        if (snapshot.files.has(remotePath)) {
          changes.push({ path: remotePath, delete: true, group: remotePath });
        }
      } else {
        changes.push({ path: remotePath, content, group: remotePath });
        for (const old of existingChunkPaths) {
          changes.push({ path: old, delete: true, group: remotePath });
        }
      }
    }
    return changes;
  }

  /** Agrupa as pastas "<arquivo>.chunks/" do snapshot em arquivos virtuais (sha/tamanho do conteúdo original). */
  private async collapseChunkedFiles(gh: GitHubService, snapshot: RemoteSnapshot): Promise<Map<string, RemoteFile>> {
    const result = new Map<string, RemoteFile>();
    type ChunkGroup = { manifest?: RemoteFile; paths: string[]; partShas: Map<string, string> };
    const groups = new Map<string, ChunkGroup>();
    for (const file of snapshot.files.values()) {
      const chunk = parseChunkPath(file.path);
      if (!chunk) {
        result.set(file.path, file);
        continue;
      }
      const group: ChunkGroup = groups.get(chunk.basePath) ?? { paths: [], partShas: new Map<string, string>() };
      group.paths.push(file.path);
      if (chunk.name === CHUNK_MANIFEST) {
        group.manifest = file;
      } else {
        group.partShas.set(file.path, file.sha);
      }
      groups.set(chunk.basePath, group);
    }

    await runWithConcurrency([...groups.entries()], 4, async ([basePath, group]) => {
      if (!group.manifest) {
        this.host.log(`${basePath}: partes sem manifesto no remoto; ignorado.`);
        return;
      }
      let manifest = this.manifestCache.get(group.manifest.sha);
      if (!manifest) {
        try {
          manifest = parseManifest(await gh.getBlob(group.manifest.sha));
          this.manifestCache.set(group.manifest.sha, manifest);
        } catch (err) {
          if (err instanceof GitHubError && err.kind !== 'other' && err.kind !== 'notFound') {
            throw err;
          }
          this.host.log(`${basePath}: manifesto inválido (${(err as Error).message}); ignorado.`);
          return;
        }
      }
      result.set(basePath, {
        path: basePath,
        sha: manifest.sha,
        size: manifest.size,
        chunked: { manifest, partShas: group.partShas, allPaths: group.paths },
      });
    });
    return result;
  }

  private async loadRemoteState(gh: GitHubService): Promise<RemoteState> {
    const snapshot = await gh.getSnapshot(REMOTE_ROOT);
    const projects = new Map<string, RemoteProject>();
    const metadataFiles = new Map<string, RemoteFile>();

    for (const file of (await this.collapseChunkedFiles(gh, snapshot)).values()) {
      const rest = file.path.slice(REMOTE_ROOT.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) {
        continue;
      }
      const key = rest.slice(0, slash);
      const relPath = rest.slice(slash + 1);
      if (!isSafeName(key)) {
        this.host.log(`Projeto remoto com nome inválido ignorado: ${JSON.stringify(key)}`);
        continue;
      }
      let project = projects.get(key);
      if (!project) {
        project = { key, sessions: new Map() };
        projects.set(key, project);
      }
      if (relPath === METADATA_FILE) {
        metadataFiles.set(key, file);
        continue;
      }
      const sessionId = relPath.includes('/') ? relPath.slice(0, relPath.indexOf('/')) : relPath.endsWith('.jsonl') ? relPath.slice(0, -'.jsonl'.length) : undefined;
      if (!sessionId || !isSafeName(sessionId)) {
        if (sessionId) {
          this.host.log(`Sessão remota com nome inválido ignorada: ${key}/${JSON.stringify(sessionId)}`);
        }
        continue;
      }
      let session = project.sessions.get(sessionId);
      if (!session) {
        session = { id: sessionId, files: new Map(), totalSize: 0 };
        project.sessions.set(sessionId, session);
      }
      session.files.set(relPath, file);
      session.totalSize += file.size;
    }

    // Sessões precisam do .jsonl principal; pastas órfãs são descartadas da listagem.
    for (const project of projects.values()) {
      for (const [id, session] of project.sessions) {
        if (!session.files.has(`${id}.jsonl`)) {
          project.sessions.delete(id);
        }
      }
    }

    await runWithConcurrency([...metadataFiles.entries()], 4, async ([key, file]) => {
      const project = projects.get(key);
      if (!project) {
        return;
      }
      if (!this.metadataBlobCache.has(file.sha)) {
        try {
          const raw = await gh.getBlob(file.sha);
          this.metadataBlobCache.set(file.sha, sanitizeMetadata(JSON.parse(raw.toString('utf8'))));
        } catch (err) {
          if (err instanceof GitHubError && (err.kind === 'auth' || err.kind === 'rateLimit')) {
            throw err;
          }
          this.host.log(`metadata.json inválido em ${key}: ${(err as Error).message}`);
          this.metadataBlobCache.set(file.sha, undefined);
        }
      }
      const metadata = this.metadataBlobCache.get(file.sha);
      if (metadata) {
        project.metadata = metadata;
        for (const [id, session] of project.sessions) {
          session.meta = Object.prototype.hasOwnProperty.call(metadata.sessions, id) ? metadata.sessions[id] : undefined;
        }
      }
    });

    return { repo: gh.fullName, snapshot, projects, fetchedAt: Date.now() };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Merge de JSONL
// ---------------------------------------------------------------------------------------------------------------

export type JsonlMergeResult =
  | { kind: 'local'; reason: 'superset' | 'equivalent' }
  | { kind: 'remote'; reason: 'superset' | 'equivalent' }
  | { kind: 'merged'; content: Buffer; localOnly: number; remoteOnly: number };

interface ParsedLine {
  raw: string;
  key: string;
  ts: number;
}

/**
 * Mescla duas versões de um histórico JSONL do Claude Code sem perder eventos.
 *
 * Cada linha é identificada pelo hash do seu conteúdo bruto (o Claude Code só anexa linhas, nunca as reescreve),
 * então a união é exata: nenhuma linha de nenhum dos lados é descartada, e linhas idênticas não são duplicadas.
 * - Se o remoto não tem nenhuma linha que falte no local      -> local vence (é superconjunto).
 * - Se o local não tem nenhuma linha que falte no remoto      -> remoto vence.
 * - Mesmo conjunto de linhas (diferença só de repetição/EOL)  -> o maior arquivo vence.
 * - Ambos têm linhas exclusivas (divergência)                 -> intercala as linhas por timestamp, preservando a
 *   ordem relativa de cada lado; linhas sem timestamp herdam o da linha anterior do mesmo arquivo.
 *   O Claude Code reconstrói a conversa via parentUuid, então eventos divergentes viram ramificações da conversa.
 */
export function mergeJsonl(localBuf: Buffer, remoteBuf: Buffer): JsonlMergeResult {
  const local = parseJsonlLines(localBuf);
  const remote = parseJsonlLines(remoteBuf);
  const localKeys = new Set(local.map((l) => l.key));
  const remoteKeys = new Set(remote.map((l) => l.key));

  const remoteOnly = remote.filter((l) => !localKeys.has(l.key));
  const localOnlyCount = local.filter((l) => !remoteKeys.has(l.key)).length;

  if (remoteOnly.length === 0 && localOnlyCount === 0) {
    return remoteBuf.length > localBuf.length ? { kind: 'remote', reason: 'equivalent' } : { kind: 'local', reason: 'equivalent' };
  }
  if (remoteOnly.length === 0) {
    return { kind: 'local', reason: 'superset' };
  }
  if (localOnlyCount === 0) {
    return { kind: 'remote', reason: 'superset' };
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < local.length || j < remoteOnly.length) {
    if (j >= remoteOnly.length) {
      out.push(local[i++].raw);
    } else if (i >= local.length) {
      out.push(remoteOnly[j++].raw);
    } else if (remoteOnly[j].ts < local[i].ts) {
      out.push(remoteOnly[j++].raw);
    } else {
      out.push(local[i++].raw);
    }
  }
  return { kind: 'merged', content: Buffer.from(out.join('\n') + '\n', 'utf8'), localOnly: localOnlyCount, remoteOnly: remoteOnly.length };
}

function parseJsonlLines(buf: Buffer): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let lastTs = 0;
  for (const rawLine of buf.toString('utf8').split('\n')) {
    const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!raw.trim()) {
      continue;
    }
    const obj = safeParse(raw);
    const ts = obj ? lineTimestamp(obj) : undefined;
    if (ts !== undefined) {
      lastTs = ts;
    }
    // SHA-256: o remoto não é confiável, e com SHA-1 seria possível forjar uma linha que colidisse com outra e fosse
    // tratada como "já presente" no merge.
    lines.push({ raw, key: crypto.createHash('sha256').update(raw).digest('hex'), ts: ts ?? lastTs });
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

type Decision = { kind: 'keepLocal' } | { kind: 'takeRemote'; content: Buffer; backup: boolean } | { kind: 'merged'; content: Buffer };

class ProjectContext {
  localSessions = new Map<string, LocalSession>();
  /** undefined = ainda não resolvido; '' = sem pasta local (pular). */
  downloadDir?: string;

  constructor(
    readonly key: string,
    readonly locals: LocalProject[],
    readonly remote: RemoteProject | undefined,
  ) {}
}

/** Junta um caminho relativo vindo do remoto impedindo path traversal ("../"). */
function safeJoin(baseDir: string, relPath: string): string {
  const segments = relPath.split('/');
  if (segments.some((s) => s === '..' || s === '' || s.includes('\\') || s.includes(':'))) {
    throw new Error(`caminho remoto inválido: ${relPath}`);
  }
  const target = path.resolve(baseDir, ...segments);
  if (!target.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`caminho remoto fora da pasta do projeto: ${relPath}`);
  }
  return target;
}

/** Nome de projeto/sessão vindo do remoto: só caracteres seguros para pasta/arquivo, sem "." ou "..". */
function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,200}$/.test(name) && name !== '.' && name !== '..';
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * O metadata.json vem do remoto (que outras pessoas com acesso de escrita podem alterar): normaliza os tipos para
 * que valores inesperados não quebrem a extensão nem sejam usados como se fossem válidos.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeMetadata(raw: any): ProjectMetadata | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

  // Objetos sem protótipo: chaves como "__proto__" ou "constructor" viram dados comuns.
  const knownPaths: Record<string, string[]> = Object.create(null);
  if (isPlainObject(raw.knownPaths)) {
    for (const [host, paths] of Object.entries(raw.knownPaths)) {
      if (Array.isArray(paths)) {
        knownPaths[host] = paths.filter((p): p is string => typeof p === 'string');
      }
    }
  }

  const sessions: Record<string, SessionMeta> = Object.create(null);
  if (isPlainObject(raw.sessions)) {
    for (const [id, s] of Object.entries(raw.sessions)) {
      if (!isPlainObject(s)) {
        continue;
      }
      const files: Record<string, RemoteFileMeta> = Object.create(null);
      if (isPlainObject(s.files)) {
        for (const [rel, f] of Object.entries(s.files)) {
          if (isPlainObject(f)) {
            files[rel] = { size: num(f.size) ?? 0, mtimeMs: num(f.mtimeMs) ?? 0, sha: str(f.sha) ?? '' };
          }
        }
      }
      sessions[id] = stripUndefined({
        title: str(s.title),
        firstTimestamp: num(s.firstTimestamp),
        lastTimestamp: num(s.lastTimestamp),
        size: num(s.size) ?? 0,
        mtimeMs: num(s.mtimeMs) ?? 0,
        updatedBy: str(s.updatedBy),
        files,
      }) as SessionMeta;
    }
  }

  return stripUndefined({
    version: 1 as const,
    key: str(raw.key) ?? '',
    displayName: str(raw.displayName) ?? '',
    gitRemote: str(raw.gitRemote),
    knownPaths,
    updatedAt: str(raw.updatedAt) ?? '',
    sessions,
  }) as ProjectMetadata;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAbsoluteForThisOs(p: string): boolean {
  return process.platform === 'win32' ? path.win32.isAbsolute(p) && /^[a-zA-Z]:/.test(p) : p.startsWith('/');
}

function redactCredentials(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//');
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? sortObject(v as Record<string, unknown>) : v));
}
