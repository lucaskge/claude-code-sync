import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Acesso à pasta local do Claude Code (~/.claude/projects ou %USERPROFILE%\.claude\projects).
 *
 * Layout local de um projeto:
 *   <projects>/<caminho-codificado>/<sessionId>.jsonl          -> histórico principal da sessão
 *   <projects>/<caminho-codificado>/<sessionId>/subagents/...   -> transcrições de subagentes
 *   <projects>/<caminho-codificado>/<sessionId>/tool-results/... -> saídas grandes de ferramentas
 *
 * Este módulo não depende da API do VS Code para poder ser testado isoladamente.
 */

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

export interface LocalFile {
  /** Caminho relativo à pasta do projeto, sempre com "/" (ex: "abc.jsonl", "abc/subagents/x.jsonl"). */
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
}

export interface LocalSession {
  id: string;
  projectKey: string;
  projectDir: string;
  mainFile: LocalFile;
  /** Arquivos auxiliares da pasta <sessionId>/ (subagentes, tool-results...). */
  extraFiles: LocalFile[];
  totalSize: number;
  mtimeMs: number;
}

export interface SessionInfo {
  title?: string;
  firstTimestamp?: number;
  lastTimestamp?: number;
  cwd?: string;
}

export interface ProjectIdentity {
  /** Chave estável usada como pasta no repositório remoto (repos/<key>/). */
  key: string;
  displayName: string;
  gitRemote?: string;
  source: 'git' | 'mapping' | 'cwd' | 'folder';
}

export interface LocalProject extends ProjectIdentity {
  folderName: string;
  dirPath: string;
  cwd?: string;
  sessionCount: number;
  lastModified: number;
}

/** Diretório base do Claude Code, respeitando CLAUDE_CONFIG_DIR quando definido. */
export function getClaudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim()) {
    return path.resolve(expandHome(override.trim()));
  }
  return path.join(os.homedir(), '.claude');
}

export function getProjectsDir(): string {
  return path.join(getClaudeHome(), 'projects');
}

function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Reproduz a codificação que o Claude Code usa para nomear a pasta do projeto:
 * todo caractere não alfanumérico vira "-".
 *   /home/usuario/projetoA    -> -home-usuario-projetoA
 *   C:\Users\usuario\projetoA -> C--Users-usuario-projetoA
 */
export function encodeProjectPath(projectPath: string): string {
  return path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'projeto';
}

/** Hash de blob no formato do Git: sha1("blob <len>\0<conteúdo>"). Permite comparar com o remoto sem baixar. */
export function gitBlobSha(content: Buffer): string {
  const hash = crypto.createHash('sha1');
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest('hex');
}

/** Normaliza uma URL de remote Git para { host, segments } (sem credenciais, protocolo ou ".git"). */
export function normalizeGitUrl(url: string): { host: string; segments: string[] } | undefined {
  let value = url.trim();
  if (!value) {
    return undefined;
  }
  // git@github.com:owner/repo.git
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(value);
  if (scp) {
    value = `ssh://${scp[1]}/${scp[2]}`;
  }
  try {
    const parsed = new URL(value);
    const segments = decodeURIComponent(parsed.pathname)
      .replace(/\.git\/?$/i, '')
      .split('/')
      .filter(Boolean);
    if (!parsed.hostname || segments.length === 0) {
      return undefined;
    }
    return { host: parsed.hostname.toLowerCase(), segments };
  } catch {
    // Caminho local usado como remote (ex: /srv/git/repo.git)
    const segments = value.replace(/\\/g, '/').replace(/\.git\/?$/i, '').split('/').filter(Boolean);
    return segments.length ? { host: 'local', segments } : undefined;
  }
}

export class ClaudeStorageService {
  private readonly cwdCache = new Map<string, { mtimeMs: number; cwd?: string }>();
  private readonly infoCache = new Map<string, { size: number; mtimeMs: number; info: SessionInfo }>();
  private readonly shaCache = new Map<string, { size: number; mtimeMs: number; sha: string }>();

  get projectsDir(): string {
    return getProjectsDir();
  }

  /**
   * Lista os projetos locais. `mappings` (nome da pasta local -> chave remota) tem precedência sobre a
   * detecção automática, garantindo que pastas associadas manualmente a um projeto remoto mantenham a chave.
   */
  async listProjects(mappings: Record<string, string> = {}): Promise<LocalProject[]> {
    const root = this.projectsDir;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const projects: LocalProject[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dirPath = path.join(root, entry.name);
      const sessionFiles = await this.listMainSessionFiles(dirPath);
      if (sessionFiles.length === 0) {
        continue;
      }
      const cwd = await this.detectProjectCwd(dirPath, sessionFiles);
      const identity = await this.resolveIdentity(cwd, entry.name, mappings[entry.name]);
      projects.push({
        ...identity,
        folderName: entry.name,
        dirPath,
        cwd,
        sessionCount: sessionFiles.length,
        lastModified: Math.max(...sessionFiles.map((f) => f.mtimeMs)),
      });
    }
    projects.sort((a, b) => b.lastModified - a.lastModified);
    return projects;
  }

  /** Lista as sessões de uma pasta de projeto local, incluindo os arquivos auxiliares de cada sessão. */
  async listSessions(project: Pick<LocalProject, 'dirPath' | 'key'>): Promise<LocalSession[]> {
    const mains = await this.listMainSessionFiles(project.dirPath);
    const sessions: LocalSession[] = [];
    for (const main of mains) {
      const id = main.relPath.slice(0, -'.jsonl'.length);
      const extraFiles = await this.walkFiles(path.join(project.dirPath, id), id);
      const all = [main, ...extraFiles];
      sessions.push({
        id,
        projectKey: project.key,
        projectDir: project.dirPath,
        mainFile: main,
        extraFiles,
        totalSize: all.reduce((sum, f) => sum + f.size, 0),
        mtimeMs: Math.max(...all.map((f) => f.mtimeMs)),
      });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions;
  }

  /**
   * Determina a identidade (chave remota) de um projeto.
   * Ordem: mapeamento manual > URL do remote Git do cwd > nome da pasta do cwd > nome da pasta do Claude.
   */
  async resolveIdentity(cwd: string | undefined, folderName: string, mappedKey?: string): Promise<ProjectIdentity> {
    const fallbackName = cwd ? path.basename(cwd) : folderName;
    const remote = cwd ? await this.readGitRemote(cwd) : undefined;

    if (mappedKey) {
      return { key: mappedKey, displayName: fallbackName, gitRemote: remote, source: 'mapping' };
    }
    if (remote) {
      const normalized = normalizeGitUrl(remote);
      if (normalized) {
        const repoName = normalized.segments[normalized.segments.length - 1];
        return {
          key: slugify(normalized.segments.join('-')),
          displayName: repoName,
          gitRemote: remote,
          source: 'git',
        };
      }
    }
    if (cwd) {
      return { key: `local-${slugify(path.basename(cwd))}`, displayName: fallbackName, source: 'cwd' };
    }
    return { key: `folder-${slugify(folderName)}`, displayName: folderName, source: 'folder' };
  }

  /** Lê a URL do remote "origin" (ou o primeiro remote) procurando o .git a partir de `startDir` para cima. */
  async readGitRemote(startDir: string): Promise<string | undefined> {
    const configPath = await this.findGitConfig(startDir);
    if (!configPath) {
      return undefined;
    }
    let text: string;
    try {
      text = await fsp.readFile(configPath, 'utf8');
    } catch {
      return undefined;
    }
    const remotes = new Map<string, string>();
    let currentRemote: string | undefined;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
      if (section) {
        currentRemote = section[1];
        continue;
      }
      if (line.startsWith('[')) {
        currentRemote = undefined;
        continue;
      }
      const urlMatch = /^url\s*=\s*(.+)$/.exec(line);
      if (currentRemote && urlMatch && !remotes.has(currentRemote)) {
        remotes.set(currentRemote, urlMatch[1].trim());
      }
    }
    return remotes.get('origin') ?? remotes.values().next().value;
  }

  private async findGitConfig(startDir: string): Promise<string | undefined> {
    let dir = path.resolve(startDir);
    for (;;) {
      const dotGit = path.join(dir, '.git');
      const stat = await fsp.stat(dotGit).catch(() => undefined);
      if (stat?.isDirectory()) {
        return path.join(dotGit, 'config');
      }
      if (stat?.isFile()) {
        // Worktree ou submódulo: ".git" é um arquivo "gitdir: <caminho>"
        const content = await fsp.readFile(dotGit, 'utf8').catch(() => '');
        const match = /^gitdir:\s*(.+)$/m.exec(content);
        if (match) {
          const gitDir = path.resolve(dir, match[1].trim());
          const commonDir = await fsp.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => undefined);
          const base = commonDir ? path.resolve(gitDir, commonDir.trim()) : gitDir;
          return path.join(base, 'config');
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  }

  /** Descobre o diretório de trabalho original do projeto lendo o campo "cwd" das sessões mais recentes. */
  private async detectProjectCwd(dirPath: string, sessionFiles: LocalFile[]): Promise<string | undefined> {
    const cached = this.cwdCache.get(dirPath);
    const newest = Math.max(...sessionFiles.map((f) => f.mtimeMs));
    if (cached && cached.mtimeMs === newest) {
      return cached.cwd;
    }
    // Sessões baixadas de outra máquina carregam o "cwd" daquela máquina; por isso preferimos o caminho
    // cuja codificação corresponde ao nome da pasta local, e só usamos outro como último recurso.
    const folderName = path.basename(dirPath);
    let fallback: string | undefined;
    let cwd: string | undefined;
    const ordered = [...sessionFiles].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 20);
    search: for (const file of ordered) {
      const head = await readHead(file.absPath, HEAD_BYTES);
      for (const match of head.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
        let candidate: string;
        try {
          candidate = JSON.parse(`"${match[1]}"`) as string;
        } catch {
          candidate = match[1];
        }
        if (encodeProjectPath(candidate) === folderName) {
          cwd = candidate;
          break search;
        }
        fallback ??= candidate;
      }
    }
    cwd ??= fallback;
    this.cwdCache.set(dirPath, { mtimeMs: newest, cwd });
    return cwd;
  }

  /** Extrai título (ai-title / primeira mensagem do usuário) e timestamps de uma sessão, lendo só início e fim. */
  async readSessionInfo(file: LocalFile): Promise<SessionInfo> {
    const cached = this.infoCache.get(file.absPath);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      return cached.info;
    }
    const info: SessionInfo = {};
    const head = await readHead(file.absPath, HEAD_BYTES);
    const tail = file.size > HEAD_BYTES ? await readTail(file.absPath, TAIL_BYTES) : head;

    let firstUserText: string | undefined;
    for (const line of completeLines(head, false)) {
      const obj = safeParse(line);
      if (!obj) {
        continue;
      }
      const ts = lineTimestamp(obj);
      if (ts !== undefined && info.firstTimestamp === undefined) {
        info.firstTimestamp = ts;
      }
      if (!info.cwd && typeof obj.cwd === 'string') {
        info.cwd = obj.cwd;
      }
      if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        info.title = obj.aiTitle;
      }
      if (!firstUserText && obj.type === 'user') {
        firstUserText = extractUserText(obj);
      }
    }
    for (const line of completeLines(tail, file.size > HEAD_BYTES)) {
      const obj = safeParse(line);
      if (!obj) {
        continue;
      }
      const ts = lineTimestamp(obj);
      if (ts !== undefined && (info.lastTimestamp === undefined || ts > info.lastTimestamp)) {
        info.lastTimestamp = ts;
      }
      if ((obj.type === 'ai-title' && typeof obj.aiTitle === 'string') || (obj.type === 'custom-title' && typeof obj.customTitle === 'string')) {
        info.title = (obj.aiTitle ?? obj.customTitle) as string;
      } else if (obj.type === 'summary' && typeof obj.summary === 'string' && !info.title) {
        info.title = obj.summary;
      }
    }
    if (!info.title && firstUserText) {
      info.title = firstUserText;
    }
    if (info.title) {
      info.title = info.title.replace(/\s+/g, ' ').trim().slice(0, 100);
    }
    this.infoCache.set(file.absPath, { size: file.size, mtimeMs: file.mtimeMs, info });
    return info;
  }

  /** sha de blob Git de um arquivo local, com cache por (tamanho, mtime). */
  async fileSha(file: LocalFile): Promise<string> {
    const cached = this.shaCache.get(file.absPath);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      return cached.sha;
    }
    const content = await fsp.readFile(file.absPath);
    const sha = gitBlobSha(content);
    this.shaCache.set(file.absPath, { size: file.size, mtimeMs: file.mtimeMs, sha });
    return sha;
  }

  async readFile(absPath: string): Promise<{ content: Buffer; size: number; mtimeMs: number }> {
    const stat = await fsp.stat(absPath);
    const content = await fsp.readFile(absPath);
    return { content, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  /**
   * Grava de forma atômica (arquivo temporário + rename).
   * Se `expected` for informado e o arquivo tiver mudado desde a leitura (ex: o Claude Code acabou de anexar
   * uma linha), a gravação é abortada e retorna false — nada é perdido, a próxima sincronização tenta de novo.
   * Se `expected` for null, só grava se o arquivo ainda não existir.
   */
  async writeFileSafe(absPath: string, content: Buffer, expected?: { size: number; mtimeMs: number } | null): Promise<boolean> {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.claude-sync-${process.pid}-${Date.now()}.tmp`;
    await fsp.writeFile(tmp, content);
    try {
      const current = await fsp.stat(absPath).catch(() => undefined);
      if (expected === null && current) {
        return false;
      }
      if (expected && (!current || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs)) {
        return false;
      }
      await renameWithRetry(tmp, absPath);
      this.infoCache.delete(absPath);
      this.shaCache.delete(absPath);
      return true;
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Cria uma cópia de segurança "<arquivo>.<yyyyMMdd-HHmmss>.bak" ao lado do original. */
  async backupFile(absPath: string): Promise<string> {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let target = `${absPath}.${stamp}.bak`;
    for (let i = 1; fs.existsSync(target); i++) {
      target = `${absPath}.${stamp}-${i}.bak`;
    }
    await fsp.copyFile(absPath, target);
    return target;
  }

  async statFile(absPath: string): Promise<LocalFile | undefined> {
    const stat = await fsp.stat(absPath).catch(() => undefined);
    if (!stat?.isFile()) {
      return undefined;
    }
    return { relPath: path.basename(absPath), absPath, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  private async listMainSessionFiles(dirPath: string): Promise<LocalFile[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: LocalFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const absPath = path.join(dirPath, entry.name);
      const stat = await fsp.stat(absPath).catch(() => undefined);
      if (stat) {
        files.push({ relPath: entry.name, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    return files;
  }

  private async walkFiles(dir: string, relBase: string): Promise<LocalFile[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: LocalFile[] = [];
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = `${relBase}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(...(await this.walkFiles(absPath, relPath)));
      } else if (entry.isFile() && !entry.name.endsWith('.bak') && !entry.name.endsWith('.tmp')) {
        const stat = await fsp.stat(absPath).catch(() => undefined);
        if (stat) {
          files.push({ relPath, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    }
    return files;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers de leitura parcial / parsing de linhas JSONL
// ---------------------------------------------------------------------------------------------------------------

async function readHead(absPath: string, bytes: number): Promise<string> {
  const handle = await fsp.open(absPath, 'r').catch(() => undefined);
  if (!handle) {
    return '';
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readTail(absPath: string, bytes: number): Promise<string> {
  const handle = await fsp.open(absPath, 'r').catch(() => undefined);
  if (!handle) {
    return '';
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Retorna as linhas completas de um trecho (descarta a primeira se o trecho começa no meio de uma linha). */
function completeLines(chunk: string, startsMidLine: boolean): string[] {
  const lines = chunk.split('\n');
  if (startsMidLine) {
    lines.shift();
  }
  if (!chunk.endsWith('\n')) {
    lines.pop();
  }
  return lines.map((l) => l.trim()).filter(Boolean);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeParse(line: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lineTimestamp(obj: Record<string, any>): number | undefined {
  const raw = obj.timestamp ?? obj.snapshot?.timestamp;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return undefined;
  }
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUserText(obj: Record<string, any>): string | undefined {
  const content = obj.message?.content;
  const texts: string[] = [];
  if (typeof content === 'string') {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
  }
  // Ignora blocos injetados pela IDE/CLI (<ide_selection>, <command-name>...) e usa o texto digitado.
  const typed = texts.map((t) => t.trim()).find((t) => t && !t.startsWith('<'));
  return typed;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // No Windows o rename pode falhar com EPERM/EBUSY se outro processo estiver com o arquivo aberto.
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
