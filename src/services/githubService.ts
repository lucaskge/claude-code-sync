/**
 * Cliente mínimo da API REST do GitHub (Git Data API) usando o fetch nativo do Node/VS Code.
 * Não depende de Git CLI nem toca em nenhum diretório .git local.
 *
 * Todas as alterações de uma sincronização viram UM commit (blobs -> tree -> commit -> update ref),
 * com detecção de conflito (fast-forward) quando outra máquina enviou algo no meio do caminho.
 */

import type { ChunkedInfo } from './chunkedStorage';

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'claude-code-sync-vscode';
/** Acima disso nem tentamos (arquivos grandes são divididos em partes; ver chunkedStorage.ts). */
export const MAX_REMOTE_FILE_BYTES = 1024 * 1024 * 1024;

export type GitHubErrorKind = 'auth' | 'forbidden' | 'notFound' | 'rateLimit' | 'conflict' | 'emptyRepo' | 'network' | 'other';

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly kind: GitHubErrorKind,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RemoteFile {
  path: string;
  /** sha do blob; para arquivos divididos em partes, sha do conteúdo original remontado. */
  sha: string;
  size: number;
  /** Presente quando o arquivo está guardado comprimido e dividido (ver chunkedStorage.ts). */
  chunked?: ChunkedInfo;
}

export interface RemoteSnapshot {
  branch: string;
  empty: boolean;
  commitSha?: string;
  treeSha?: string;
  /** Somente arquivos dentro de `prefix` (por padrão "repos/"). */
  files: Map<string, RemoteFile>;
}

export interface FileChange {
  path: string;
  /** Conteúdo a gravar; ausente quando `delete` é true. */
  content?: Buffer;
  /** Remove o arquivo do repositório. */
  delete?: boolean;
  /**
   * Alterações do mesmo grupo são aplicadas juntas ou nenhuma é: se o envio de uma parte falhar, as demais
   * partes e as remoções do grupo são descartadas (evita apagar a versão antiga sem a nova estar completa).
   */
  group?: string;
}

export interface CommitResult {
  /** undefined quando nenhuma alteração pôde ser enviada. */
  sha?: string;
  failed: { group: string; message: string }[];
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

type Logger = (message: string) => void;

export function parseRepoInput(input: string): RepoRef | undefined {
  const value = input.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!value) {
    return undefined;
  }
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(value);
  if (scp) {
    return validRepoRef(scp[1], scp[2]);
  }
  const short = /^([^/:]+)\/([^/]+)$/.exec(value);
  if (short) {
    return validRepoRef(short[1], short[2]);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(url.hostname)) {
      return undefined;
    }
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return owner && repo ? validRepoRef(owner, repo) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Aplica as regras de nome do GitHub. Como owner/repo entram no caminho das requisições à API, valores como
 * ".." ou com caracteres codificados poderiam redirecionar a chamada (com o token do usuário) para outro endpoint.
 */
function validRepoRef(owner: string, repo: string): RepoRef | undefined {
  const ownerOk = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner);
  const repoOk = /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== '.' && repo !== '..';
  return ownerOk && repoOk ? { owner, repo } : undefined;
}

export class GitHubService {
  private defaultBranch?: string;

  constructor(
    public readonly ref: RepoRef,
    private readonly token: string,
    private readonly log: Logger = () => undefined,
  ) {}

  get fullName(): string {
    return `${this.ref.owner}/${this.ref.repo}`;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Repositório
  // ------------------------------------------------------------------------------------------------------------

  async getAuthenticatedLogin(): Promise<string> {
    const user = await this.request<{ login: string }>('GET', '/user');
    return user.login;
  }

  async getRepository(): Promise<{ private: boolean; default_branch: string; full_name: string; permissions?: { push?: boolean } }> {
    const repo = await this.request<{ private: boolean; default_branch: string; full_name: string; permissions?: { push?: boolean } }>(
      'GET',
      `/repos/${this.ref.owner}/${this.ref.repo}`,
    );
    this.defaultBranch = repo.default_branch || 'main';
    return repo;
  }

  /** Cria o repositório privado (na conta do usuário ou na organização indicada em `owner`). */
  async createPrivateRepository(): Promise<void> {
    const login = await this.getAuthenticatedLogin();
    const body = {
      name: this.ref.repo,
      private: true,
      auto_init: true,
      description: 'Backup das sessões do Claude Code (Claude Code Sync)',
    };
    if (login.toLowerCase() === this.ref.owner.toLowerCase()) {
      await this.request('POST', '/user/repos', body);
    } else {
      await this.request('POST', `/orgs/${this.ref.owner}/repos`, body);
    }
    this.defaultBranch = undefined;
  }

  /** Em repositório vazio a Git Data API não funciona; cria um README inicial via Contents API. */
  async initializeRepository(): Promise<void> {
    const readme = [
      '# Claude Code Sync',
      '',
      'Backup automático das sessões do Claude Code gerado pela extensão **Claude Code Sync** do VS Code.',
      '',
      '- `repos/<projeto>/<sessionId>.jsonl` — histórico bruto de cada conversa',
      '- `repos/<projeto>/<sessionId>/...` — subagentes e resultados de ferramentas da sessão',
      '- `repos/<projeto>/metadata.json` — índice (títulos, datas, caminhos conhecidos por máquina)',
      '',
      '> Mantenha este repositório **privado**: as conversas podem conter código e dados sensíveis.',
      '',
    ].join('\n');
    await this.request('PUT', `/repos/${this.ref.owner}/${this.ref.repo}/contents/README.md`, {
      message: 'Claude Sync: inicializa repositório',
      content: Buffer.from(readme, 'utf8').toString('base64'),
    });
    this.defaultBranch = undefined;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Leitura
  // ------------------------------------------------------------------------------------------------------------

  async getSnapshot(prefix = 'repos/'): Promise<RemoteSnapshot> {
    if (!this.defaultBranch) {
      await this.getRepository();
    }
    const branch = this.defaultBranch ?? 'main';
    const files = new Map<string, RemoteFile>();

    let commitSha: string;
    try {
      const ref = await this.request<{ object: { sha: string } }>(
        'GET',
        `/repos/${this.ref.owner}/${this.ref.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      commitSha = ref.object.sha;
    } catch (err) {
      if (err instanceof GitHubError && (err.kind === 'emptyRepo' || err.kind === 'notFound')) {
        return { branch, empty: true, files };
      }
      throw err;
    }

    const commit = await this.request<{ tree: { sha: string } }>('GET', `/repos/${this.ref.owner}/${this.ref.repo}/git/commits/${commitSha}`);
    const treeSha = commit.tree.sha;

    // Desce direto até o prefixo (ex: "repos/") para não listar o repositório inteiro.
    let subtreeSha: string | undefined = treeSha;
    let base = '';
    for (const segment of prefix.split('/').filter(Boolean)) {
      const tree = await this.getTree(subtreeSha, false);
      const entry = tree.tree.find((e) => e.type === 'tree' && e.path === segment);
      if (!entry) {
        subtreeSha = undefined;
        break;
      }
      subtreeSha = entry.sha;
      base += `${segment}/`;
    }
    if (subtreeSha) {
      await this.collectTree(subtreeSha, base, files);
    }
    return { branch, empty: false, commitSha, treeSha, files };
  }

  async getBlob(sha: string): Promise<Buffer> {
    const blob = await this.request<{ content: string; encoding: string; size: number }>(
      'GET',
      `/repos/${this.ref.owner}/${this.ref.repo}/git/blobs/${sha}`,
    );
    if (blob.encoding === 'base64') {
      return Buffer.from(blob.content, 'base64');
    }
    return Buffer.from(blob.content, 'utf8');
  }

  private async getTree(sha: string, recursive: boolean): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
    return this.request('GET', `/repos/${this.ref.owner}/${this.ref.repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
  }

  /** Lista recursivamente; se a resposta vier truncada (árvores enormes), desce nível a nível. */
  private async collectTree(sha: string, base: string, out: Map<string, RemoteFile>): Promise<void> {
    const full = await this.getTree(sha, true);
    if (!full.truncated) {
      for (const entry of full.tree) {
        if (entry.type === 'blob') {
          out.set(base + entry.path, { path: base + entry.path, sha: entry.sha, size: entry.size ?? 0 });
        }
      }
      return;
    }
    this.log(`Árvore ${base || '/'} truncada pela API; listando nível a nível.`);
    const shallow = await this.getTree(sha, false);
    for (const entry of shallow.tree) {
      if (entry.type === 'blob') {
        out.set(base + entry.path, { path: base + entry.path, sha: entry.sha, size: entry.size ?? 0 });
      } else if (entry.type === 'tree') {
        await this.collectTree(entry.sha, `${base}${entry.path}/`, out);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Escrita
  // ------------------------------------------------------------------------------------------------------------

  /**
   * Cria um único commit com todas as alterações sobre `base`.
   * Um arquivo que o GitHub recusar (ex: 422 "input too large") não derruba o envio dos demais: o grupo dele é
   * descartado e informado em `failed`.
   * Lança GitHubError('conflict') se o branch andou desde o snapshot (outra máquina sincronizou).
   */
  async commitFiles(base: RemoteSnapshot, changes: FileChange[], message: string, onProgress?: (done: number, total: number) => void): Promise<CommitResult> {
    if (base.empty || !base.commitSha || !base.treeSha) {
      throw new GitHubError('Repositório remoto vazio: inicialize-o antes de enviar arquivos.', 'emptyRepo');
    }
    const entries = new Map<FileChange, { path: string; mode: '100644'; type: 'blob'; sha: string | null }>();
    const failedGroups = new Map<string, string>();
    const uploads = changes.filter((c) => !c.delete && c.content);
    let done = 0;

    await runWithConcurrency(uploads, 3, async (change) => {
      const group = change.group ?? change.path;
      if (failedGroups.has(group)) {
        onProgress?.(++done, uploads.length);
        return;
      }
      try {
        const blob = await this.request<{ sha: string }>('POST', `/repos/${this.ref.owner}/${this.ref.repo}/git/blobs`, {
          content: change.content!.toString('base64'),
          encoding: 'base64',
        });
        entries.set(change, { path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
      } catch (err) {
        // Erros de conta/limite/rede afetam tudo: aborta. Erros do próprio arquivo: descarta só o grupo.
        if (err instanceof GitHubError && (err.kind === 'other' || err.status === 422)) {
          failedGroups.set(group, err.message);
          this.log(`Falha ao enviar ${change.path}: ${err.message}`);
        } else {
          throw err;
        }
      }
      onProgress?.(++done, uploads.length);
    });
    for (const change of changes) {
      if (change.delete) {
        entries.set(change, { path: change.path, mode: '100644', type: 'blob', sha: null });
      }
    }

    const failed = [...failedGroups.entries()].map(([group, msg]) => ({ group, message: msg }));
    const tree = [...entries.entries()].filter(([change]) => !failedGroups.has(change.group ?? change.path)).map(([, entry]) => entry);
    if (tree.length === 0) {
      return { failed };
    }

    const newTree = await this.request<{ sha: string }>('POST', `/repos/${this.ref.owner}/${this.ref.repo}/git/trees`, {
      base_tree: base.treeSha,
      tree,
    });
    const commit = await this.request<{ sha: string }>('POST', `/repos/${this.ref.owner}/${this.ref.repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [base.commitSha],
    });
    try {
      await this.request('PATCH', `/repos/${this.ref.owner}/${this.ref.repo}/git/refs/heads/${encodeURIComponent(base.branch)}`, {
        sha: commit.sha,
        force: false,
      });
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 422 || err.status === 409)) {
        throw new GitHubError('O repositório remoto foi atualizado por outra máquina durante a sincronização.', 'conflict', err.status);
      }
      throw err;
    }
    return { sha: commit.sha, failed };
  }

  // ------------------------------------------------------------------------------------------------------------
  // HTTP
  // ------------------------------------------------------------------------------------------------------------

  private async request<T = unknown>(method: string, apiPath: string, body?: unknown, attempt = 0): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${apiPath}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': USER_AGENT,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt < 3) {
        await delay(1000 * 2 ** attempt);
        return this.request<T>(method, apiPath, body, attempt + 1);
      }
      throw new GitHubError(`Falha de rede ao acessar o GitHub: ${(err as Error).message}`, 'network');
    }

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }

    const text = await response.text().catch(() => '');
    let apiMessage = text;
    try {
      apiMessage = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // corpo não-JSON
    }
    const status = response.status;
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const retryAfter = response.headers.get('retry-after');

    // Limite secundário (abuso): o GitHub manda esperar alguns segundos.
    if ((status === 403 || status === 429) && retryAfter && attempt < 3) {
      const waitMs = Math.min(Number(retryAfter) * 1000 || 5000, 60_000);
      this.log(`Limite secundário da API atingido; aguardando ${Math.round(waitMs / 1000)}s...`);
      await delay(waitMs);
      return this.request<T>(method, apiPath, body, attempt + 1);
    }
    if ((status === 403 || status === 429) && (remaining === '0' || /rate limit/i.test(apiMessage))) {
      const resetAt = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : 'em alguns minutos';
      throw new GitHubError(`Limite de requisições da API do GitHub atingido. Tente novamente após ${resetAt}.`, 'rateLimit', status);
    }
    if (status >= 500 && attempt < 3) {
      await delay(1000 * 2 ** attempt);
      return this.request<T>(method, apiPath, body, attempt + 1);
    }

    switch (status) {
      case 401:
        throw new GitHubError('Token do GitHub inválido ou expirado. Execute "Claude Sync: Configure GitHub Credentials".', 'auth', status);
      case 403:
        throw new GitHubError(`Acesso negado pelo GitHub (${apiMessage}). Verifique se o token tem permissão "repo" / "Contents: Read and write".`, 'forbidden', status);
      case 404:
        throw new GitHubError(`Repositório ${this.fullName} não encontrado ou sem acesso para este token.`, 'notFound', status);
      case 409:
        if (/empty/i.test(apiMessage)) {
          throw new GitHubError('Repositório remoto vazio.', 'emptyRepo', status);
        }
        throw new GitHubError(`Conflito no GitHub: ${apiMessage}`, 'conflict', status);
      default:
        throw new GitHubError(`Erro ${status} da API do GitHub em ${method} ${apiPath}: ${apiMessage}`, 'other', status);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}
