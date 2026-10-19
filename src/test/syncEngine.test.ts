import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ClaudeStorageService, encodeProjectPath, gitBlobSha } from '../services/claudeStorageService';
import * as zlib from 'node:zlib';

import { CHUNK_THRESHOLD_BYTES, PART_SIZE_BYTES, decodeChunked, parseManifest } from '../services/chunkedStorage';
import { CommitResult, FileChange, GitHubError, GitHubService, RemoteFile, RemoteSnapshot, parseRepoInput } from '../services/githubService';
import { SyncEngine, SyncHost, mergeJsonl } from '../services/syncEngine';
import { t } from '../i18n';

// ---------------------------------------------------------------------------------------------------------------
// Fake do GitHub em memória (mesma semântica de commit/fast-forward da API real)
// ---------------------------------------------------------------------------------------------------------------

class FakeGitHub {
  readonly fullName = 'acme/claude-backup';
  files = new Map<string, Buffer>();
  blobs = new Map<string, Buffer>();
  commit = 0;
  empty = true;
  isPrivate = true;

  async getRepository() {
    return { private: this.isPrivate, default_branch: 'main', full_name: this.fullName };
  }

  async getSnapshot(prefix = 'repos/'): Promise<RemoteSnapshot> {
    if (this.empty) {
      return { branch: 'main', empty: true, files: new Map() };
    }
    const files = new Map<string, RemoteFile>();
    for (const [p, content] of this.files) {
      if (p.startsWith(prefix)) {
        const sha = gitBlobSha(content);
        this.blobs.set(sha, content);
        files.set(p, { path: p, sha, size: content.length });
      }
    }
    return { branch: 'main', empty: false, commitSha: `c${this.commit}`, treeSha: `t${this.commit}`, files };
  }

  async initializeRepository(): Promise<void> {
    this.empty = false;
    this.files.set('README.md', Buffer.from('# backup\n'));
    this.commit++;
  }

  async getBlob(sha: string): Promise<Buffer> {
    const blob = this.blobs.get(sha);
    if (!blob) {
      throw new GitHubError('blob não encontrado', 'notFound', 404);
    }
    return blob;
  }

  /** Simula o limite de tamanho da API de blobs do GitHub (422 "input too large"). */
  maxBlobBytes = Infinity;
  largestBlobSent = 0;

  async commitFiles(base: RemoteSnapshot, changes: FileChange[]): Promise<CommitResult> {
    if (base.commitSha !== `c${this.commit}`) {
      throw new GitHubError('não é fast-forward', 'conflict', 422);
    }
    const failedGroups = new Map<string, string>();
    for (const change of changes) {
      if (change.content && change.content.length > this.maxBlobBytes) {
        failedGroups.set(change.group ?? change.path, 'Sorry, your input was too large to process.');
      }
    }
    const applied = changes.filter((c) => !failedGroups.has(c.group ?? c.path));
    for (const change of applied) {
      if (change.delete) {
        this.files.delete(change.path);
      } else {
        this.largestBlobSent = Math.max(this.largestBlobSent, change.content!.length);
        this.files.set(change.path, change.content!);
      }
    }
    const failed = [...failedGroups].map(([group, message]) => ({ group, message }));
    if (applied.length === 0) {
      return { failed };
    }
    this.commit++;
    return { sha: `c${this.commit}`.padEnd(40, '0'), failed };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// "Máquinas" simuladas: cada uma tem seu CLAUDE_CONFIG_DIR e o projeto num caminho diferente
// ---------------------------------------------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));

class Machine {
  readonly claudeHome: string;
  readonly projectPath: string;
  readonly mappings: Record<string, string> = {};

  constructor(
    readonly name: string,
    private readonly gh: FakeGitHub,
  ) {
    this.claudeHome = path.join(tmpRoot, name, '.claude');
    this.projectPath = path.join(tmpRoot, name, 'code', `projetoA-${name}`);
    fs.mkdirSync(path.join(this.projectPath, '.git'), { recursive: true });
    fs.writeFileSync(path.join(this.projectPath, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/projetoA.git\n');
    fs.mkdirSync(this.projectDir, { recursive: true });
  }

  get projectDir(): string {
    return path.join(this.claudeHome, 'projects', encodeProjectPath(this.projectPath));
  }

  sessionPath(id: string): string {
    return path.join(this.projectDir, `${id}.jsonl`);
  }

  writeSession(id: string, lines: object[], cwd = this.projectPath): void {
    fs.writeFileSync(this.sessionPath(id), lines.map((l) => JSON.stringify({ ...l, cwd, sessionId: id })).join('\n') + '\n');
  }

  appendLine(id: string, line: object): void {
    fs.appendFileSync(this.sessionPath(id), JSON.stringify({ ...line, cwd: this.projectPath, sessionId: id }) + '\n');
  }

  uuids(id: string): string[] {
    return fs
      .readFileSync(this.sessionPath(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).uuid as string);
  }

  backups(): string[] {
    return fs.readdirSync(this.projectDir).filter((f) => f.endsWith('.bak'));
  }

  /** Envelhece os arquivos para não caírem na janela de "sessão em uso". */
  ageFiles(): void {
    const past = new Date(Date.now() - 60_000);
    for (const f of fs.readdirSync(this.projectDir)) {
      fs.utimesSync(path.join(this.projectDir, f), past, past);
    }
  }

  async sync(direction: 'push' | 'pull' | 'sync' = 'sync') {
    process.env.CLAUDE_CONFIG_DIR = this.claudeHome;
    this.ageFiles();
    const host: SyncHost = {
      getGitHub: async () => this.gh as unknown as GitHubService,
      getMappings: () => this.mappings,
      setMapping: async (folder, key) => {
        this.mappings[folder] = key;
      },
      workspacePaths: () => [this.projectPath],
      log: () => undefined,
    };
    const engine = new SyncEngine(new ClaudeStorageService(), host);
    return engine.run({ direction, scope: { kind: 'all' }, interactive: false });
  }
}

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const ev = (uuid: string, minute: number) => ({ type: 'user', uuid, timestamp: `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`, message: { role: 'user', content: uuid } });

describe('mergeJsonl', () => {
  const buf = (...lines: string[]) => Buffer.from(lines.map((l) => l + '\n').join(''));
  const l = (uuid: string, minute: number) => JSON.stringify(ev(uuid, minute));

  it('local superconjunto vence', () => {
    assert.deepEqual(mergeJsonl(buf(l('1', 1), l('2', 2)), buf(l('1', 1))), { kind: 'local', reason: 'superset' });
  });

  it('remoto superconjunto vence', () => {
    assert.deepEqual(mergeJsonl(buf(l('1', 1)), buf(l('1', 1), l('2', 2))), { kind: 'remote', reason: 'superset' });
  });

  it('divergência intercala por timestamp sem perder linhas', () => {
    const titleLine = JSON.stringify({ type: 'ai-title', aiTitle: 'x' });
    const result = mergeJsonl(buf(l('1', 1), l('3', 3), titleLine), buf(l('1', 1), l('2', 2), l('4', 4)));
    assert.equal(result.kind, 'merged');
    if (result.kind !== 'merged') {
      return;
    }
    const uuids = result.content
      .toString()
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x).uuid ?? 'title');
    assert.deepEqual(uuids, ['1', '2', '3', 'title', '4']);
    assert.equal(result.localOnly, 2);
    assert.equal(result.remoteOnly, 2);
  });

  it('mesmo conjunto de linhas: maior arquivo vence', () => {
    const r = mergeJsonl(buf(l('1', 1)), Buffer.from(l('1', 1) + '\n' + l('1', 1) + '\n'));
    assert.deepEqual(r, { kind: 'remote', reason: 'equivalent' });
  });
});

describe('SyncEngine (duas máquinas, caminhos diferentes)', () => {
  const gh = new FakeGitHub();
  const m1 = new Machine('m1', gh);
  const m2 = new Machine('m2', gh);

  it('cenário A/B/C: nada é perdido e as duas máquinas convergem', async () => {
    m1.writeSession(A, [ev('a1', 1), ev('a2', 2), ev('a3', 3)]);
    m1.writeSession(B, [ev('b1', 5)]);
    m2.writeSession(A, [ev('a1', 1), ev('a2', 2)], m1.projectPath); // A desatualizada (cópia antiga vinda da máquina 1)
    m2.writeSession(C, [ev('c1', 7)]); // C nova, só na máquina 2

    const r1 = await m1.sync();
    assert.equal(r1.uploaded, 2);
    assert.ok(gh.files.has(`repos/acme-projetoa/${A}.jsonl`), 'chave remota derivada do remote Git, não do caminho local');
    assert.ok(gh.files.has('repos/acme-projetoa/metadata.json'));

    const r2 = await m2.sync();
    assert.equal(r2.downloaded, 2); // B novo + A atualizado
    assert.equal(r2.uploaded, 1); // C
    assert.deepEqual(m2.uuids(A), ['a1', 'a2', 'a3']);
    assert.deepEqual(m2.uuids(B), ['b1']);
    assert.deepEqual(m2.uuids(C), ['c1']);
    assert.deepEqual(m2.backups(), [], 'atualização por superconjunto não precisa de backup');

    await m1.sync();
    assert.deepEqual(m1.uuids(C), ['c1']);

    const metadata = JSON.parse(gh.files.get('repos/acme-projetoa/metadata.json')!.toString());
    assert.equal(Object.keys(metadata.knownPaths).length, 1); // mesmo hostname nos testes
    assert.ok(metadata.knownPaths[os.hostname()].includes(m1.projectPath));
    assert.ok(metadata.knownPaths[os.hostname()].includes(m2.projectPath));
  });

  it('divergência: mescla os dois lados e gera .bak local', async () => {
    m1.appendLine(A, ev('a4-m1', 10));
    m2.appendLine(A, ev('a5-m2', 11));

    await m1.sync();
    const r2 = await m2.sync();
    assert.equal(r2.merged, 1);
    assert.equal(m2.backups().length, 1);
    assert.deepEqual(m2.uuids(A), ['a1', 'a2', 'a3', 'a4-m1', 'a5-m2']);

    await m1.sync();
    assert.deepEqual(m1.uuids(A), ['a1', 'a2', 'a3', 'a4-m1', 'a5-m2']);
    assert.equal(m1.backups().length, 0);
  });

  it('push não sobrescreve remoto mais novo e pull não envia nada', async () => {
    m1.appendLine(B, ev('b2', 20));
    const before = gh.commit;
    const pull = await m2.sync('pull');
    assert.equal(pull.uploaded, 0);
    assert.equal(gh.commit, before);

    await m1.sync('push');
    const push = await m2.sync('push');
    assert.equal(push.uploaded, 0);
    assert.ok(push.warnings.some((w) => w.includes('remote has newer events')));
    assert.deepEqual(m2.uuids(B), ['b1'], 'push nunca altera o local');
    assert.ok(gh.files.get(`repos/acme-projetoa/${B}.jsonl`)!.toString().includes('b2'), 'remoto preservado');
  });

  it('sessão em uso (modificada há poucos segundos) não é sobrescrita', async () => {
    m1.appendLine(C, ev('c2', 30));
    await m1.sync();
    process.env.CLAUDE_CONFIG_DIR = m2.claudeHome;
    m2.appendLine(C, ev('c3-ativo', 31));
    // Sincroniza sem envelhecer os arquivos: C acabou de ser escrita.
    const host: SyncHost = {
      getGitHub: async () => gh as unknown as GitHubService,
      getMappings: () => m2.mappings,
      setMapping: async () => undefined,
      workspacePaths: () => [m2.projectPath],
      log: () => undefined,
    };
    const report = await new SyncEngine(new ClaudeStorageService(), host).run({ direction: 'sync', scope: { kind: 'all' }, interactive: false });
    assert.ok(report.warnings.some((w) => w.includes('in use')));
    assert.deepEqual(m2.uuids(C), ['c1', 'c3-ativo'], 'arquivo local intacto');
    const remoteC = gh.files.get(`repos/acme-projetoa/${C}.jsonl`)!.toString();
    assert.ok(remoteC.includes('c2') && remoteC.includes('c3-ativo'), 'remoto recebeu a união');
  });

  it('conflito de commit (outra máquina enviou no meio) é refeito automaticamente', async () => {
    m1.appendLine(A, ev('a6', 40));
    const original = gh.commitFiles.bind(gh);
    let first = true;
    gh.commitFiles = async (base, changes) => {
      if (first) {
        first = false;
        gh.commit++; // simula push concorrente
      }
      return original(base, changes);
    };
    const report = await m1.sync();
    gh.commitFiles = original;
    assert.equal(report.uploaded, 1);
    assert.ok(gh.files.get(`repos/acme-projetoa/${A}.jsonl`)!.toString().includes('a6'));
  });

  it('arquivo grande (> limite da API) é enviado comprimido em partes e remontado na outra máquina', async () => {
    const BIG = 'dddddddd-0000-4000-8000-000000000004';
    // Conteúdo pouco compressível (como sessões com imagens coladas): ~55 MB -> 3 partes após gzip.
    const lines = Array.from({ length: 2500 }, (_, i) => ({ ...ev(`big-${i}`, 50), blob: crypto.randomBytes(16 * 1024).toString('base64') }));
    m1.writeSession(BIG, lines);
    const original = fs.readFileSync(m1.sessionPath(BIG));
    assert.ok(original.length > CHUNK_THRESHOLD_BYTES * 2);

    gh.maxBlobBytes = PART_SIZE_BYTES; // a API recusaria o arquivo inteiro
    gh.largestBlobSent = 0;
    const push = await m1.sync();
    assert.deepEqual(push.warnings, []);
    assert.ok(gh.largestBlobSent <= PART_SIZE_BYTES, 'nenhum blob acima do limite');
    const base = `repos/acme-projetoa/${BIG}.jsonl`;
    assert.ok(!gh.files.has(base), 'arquivo inteiro não vai para o remoto');
    assert.ok(gh.files.has(`${base}.chunks/manifest.json`));
    assert.ok(gh.files.has(`${base}.chunks/part-001.gz`), 'dividido em mais de uma parte');

    await m2.sync();
    assert.ok(fs.readFileSync(m2.sessionPath(BIG)).equals(original), 'remontado byte a byte na máquina 2');

    // Continua a conversa na máquina 2: a versão nova substitui as partes antigas.
    m2.appendLine(BIG, ev('big-final', 59));
    await m2.sync();
    await m1.sync();
    assert.equal(m1.uuids(BIG).at(-1), 'big-final');
    assert.ok(fs.readFileSync(m1.sessionPath(BIG)).equals(fs.readFileSync(m2.sessionPath(BIG))));
    const report = await m1.sync();
    assert.equal(report.uploaded + report.downloaded + report.merged, 0, 'nada a fazer quando já está igual');
    gh.maxBlobBytes = Infinity;
  });

  it('um arquivo recusado pelo GitHub não impede o envio dos demais', async () => {
    const SMALL = 'eeeeeeee-0000-4000-8000-000000000005';
    const REJECTED = 'ffffffff-0000-4000-8000-000000000006';
    m1.writeSession(SMALL, [ev('s1', 1)]);
    m1.writeSession(REJECTED, [{ ...ev('r1', 1), pad: 'x'.repeat(2 * 1024 * 1024) }]);
    gh.maxBlobBytes = 1024 * 1024;
    const report = await m1.sync('push');
    gh.maxBlobBytes = Infinity;
    assert.ok(gh.files.has(`repos/acme-projetoa/${SMALL}.jsonl`), 'arquivo pequeno enviado');
    assert.ok(!gh.files.has(`repos/acme-projetoa/${REJECTED}.jsonl`));
    assert.ok(report.warnings.some((w) => w.includes(REJECTED) && w.includes('too large')));
    assert.ok(report.commitSha, 'commit criado com o restante');
  });

  it('não envia nada para repositório que se tornou público', async () => {
    m1.appendLine(A, ev('a-publico', 50));
    gh.isPrivate = false;
    const before = gh.commit;
    await assert.rejects(m1.sync('push'), (err: GitHubError) => err.kind === 'forbidden' && /PUBLIC/.test(err.message));
    assert.equal(gh.commit, before, 'nenhum commit criado');
    gh.isPrivate = true;
  });

  it('ignora projetos e sessões remotos com nomes perigosos', async () => {
    gh.files.set('repos/acme-projetoa/..jsonl', Buffer.from(JSON.stringify(ev('mal', 1)) + '\n'));
    gh.files.set('repos/acme-projetoa/../escape.txt', Buffer.from('x'));
    gh.files.set('repos/a b/evil.jsonl', Buffer.from('x'));
    gh.commit++;
    await m2.sync('pull');
    assert.ok(!fs.existsSync(path.join(m2.projectDir, 'escape.txt')));
    assert.ok(!fs.existsSync(path.join(m2.projectDir, '..jsonl')));
    gh.files.delete('repos/acme-projetoa/..jsonl');
    gh.files.delete('repos/acme-projetoa/../escape.txt');
    gh.files.delete('repos/a b/evil.jsonl');
    gh.commit++;
  });

  it('limpa diretório temporário', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe('validações de segurança', () => {
  it('parseRepoInput aceita formatos válidos', () => {
    assert.deepEqual(parseRepoInput('usuario/claude-backup'), { owner: 'usuario', repo: 'claude-backup' });
    assert.deepEqual(parseRepoInput('https://github.com/usuario/claude.backup.git'), { owner: 'usuario', repo: 'claude.backup' });
    assert.deepEqual(parseRepoInput('git@github.com:usuario/x_y.git'), { owner: 'usuario', repo: 'x_y' });
  });

  it('parseRepoInput rejeita nomes que alteram o caminho da API', () => {
    for (const bad of ['../..', 'usuario/..', 'usuario/.', '../user', 'lu%2e%2e/x', 'usuario/re?po', 'usuario/re#po', 'http://github.com/a/b', 'https://evil.github.com/a/b', 'https://github.com.evil.com/a/b']) {
      assert.equal(parseRepoInput(bad), undefined, bad);
    }
  });

  it('decodeChunked não descomprime além do tamanho declarado (bomba gzip)', () => {
    const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024));
    const manifest = parseManifest(Buffer.from(JSON.stringify({ version: 1, encoding: 'gzip', size: 10, sha: 'a'.repeat(40), parts: ['part-000.gz'] })));
    assert.throws(() => decodeChunked(manifest, [bomb]), /decompressed/);
  });

  it('parseManifest rejeita manifestos inválidos', () => {
    const base = { version: 1, encoding: 'gzip', size: 10, sha: 'a'.repeat(40), parts: ['part-000.gz'] };
    for (const bad of [
      { ...base, size: -1 },
      { ...base, size: 2 * 1024 * 1024 * 1024 },
      { ...base, sha: 'xyz' },
      { ...base, parts: [] },
      { ...base, parts: ['../x'] },
      { ...base, parts: Array.from({ length: 1000 }, (_, i) => `part-${String(i).padStart(3, '0')}.gz`) },
    ]) {
      assert.throws(() => parseManifest(Buffer.from(JSON.stringify(bad))), /invalid/, JSON.stringify(bad).slice(0, 80));
    }
  });
});

describe('traduções', () => {
  const root = path.join(__dirname, '..', '..');
  const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();

  /** Textos passados para t('...') em todo o código-fonte (exceto testes). */
  function sourceKeys(): Set<string> {
    const keys = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'test') {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          for (const m of fs.readFileSync(full, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
            keys.add(m[1].replace(/\\(.)/g, '$1'));
          }
        }
      }
    };
    walk(path.join(root, 'src'));
    return keys;
  }

  it('t() usa o texto em inglês e preenche os marcadores', () => {
    assert.equal(t('Commit {0} created.', 'abc1234'), 'Commit abc1234 created.');
    assert.equal(t('{0} and {1}', 1, true), '1 and true');
  });

  it('toda mensagem do código tem tradução pt-br, com os mesmos marcadores', () => {
    const bundle = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'bundle.l10n.pt-br.json'), 'utf8')) as Record<string, string>;
    const keys = sourceKeys();
    assert.ok(keys.size > 100, 'mensagens encontradas no código');
    assert.deepEqual([...keys].filter((k) => !(k in bundle)), [], 'mensagens sem tradução');
    assert.deepEqual(Object.keys(bundle).filter((k) => !keys.has(k)), [], 'traduções que não são mais usadas');
    for (const [en, pt] of Object.entries(bundle)) {
      assert.deepEqual(placeholders(pt), placeholders(en), en);
    }
  });

  it('todo %chave% do package.json existe em inglês e em pt-br', () => {
    const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
    const pt = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.pt-br.json'), 'utf8')) as Record<string, string>;
    const used = [...pkg.matchAll(/"%([\w.]+)%"/g)].map((m) => m[1]);
    assert.ok(used.length > 20);
    assert.deepEqual(used.filter((k) => !(k in en) || !(k in pt)), []);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort());
  });
});
