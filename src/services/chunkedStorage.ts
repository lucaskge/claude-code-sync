import * as zlib from 'zlib';

import { t } from '../i18n';
import { gitBlobSha } from './claudeStorageService';

/**
 * Armazenamento de arquivos grandes no repositório remoto.
 *
 * A API de blobs do GitHub recusa requisições grandes ("input was too large to process") bem antes do limite de
 * 100 MB por arquivo, pois o conteúdo vai em base64 dentro de um JSON. Sessões com imagens coladas passam fácil
 * de 50–150 MB e comprimem mal. Por isso, arquivos acima de CHUNK_THRESHOLD_BYTES são gravados como:
 *
 *   <arquivo>.chunks/manifest.json   -> { size, sha (do conteúdo original), parts: [...] }
 *   <arquivo>.chunks/part-000.gz     -> fatias de até PART_SIZE_BYTES do conteúdo comprimido com gzip
 *   <arquivo>.chunks/part-001.gz
 *
 * O SyncEngine trata isso de forma transparente: o arquivo aparece como um único arquivo "virtual" cujo sha é o
 * do conteúdo original, então as comparações com o local continuam funcionando sem baixar nada.
 */

export const CHUNK_DIR_SUFFIX = '.chunks';
export const CHUNK_MANIFEST = 'manifest.json';
/** Arquivos maiores que isso são divididos. */
export const CHUNK_THRESHOLD_BYTES = 20 * 1024 * 1024;
/** Tamanho máximo de cada parte (≈27 MB em base64 na requisição). */
export const PART_SIZE_BYTES = 20 * 1024 * 1024;

export interface ChunkManifest {
  version: 1;
  encoding: 'gzip';
  /** Tamanho do conteúdo original. */
  size: number;
  /** sha de blob Git do conteúdo original (o mesmo que gitBlobSha(local)). */
  sha: string;
  /** Nomes das partes, em ordem (relativos à pasta .chunks). */
  parts: string[];
}

export interface ChunkedInfo {
  manifest: ChunkManifest;
  /** Caminho remoto completo de cada parte -> sha do blob da parte. */
  partShas: Map<string, string>;
  /** Todos os caminhos remotos atuais da pasta .chunks (manifesto + partes), para limpeza. */
  allPaths: string[];
}

export function shouldChunk(content: Buffer): boolean {
  return content.length > CHUNK_THRESHOLD_BYTES;
}

export function chunkDirFor(remotePath: string): string {
  return `${remotePath}${CHUNK_DIR_SUFFIX}/`;
}

/** Se `remotePath` está dentro de uma pasta .chunks, retorna o caminho do arquivo original e o nome interno. */
export function parseChunkPath(remotePath: string): { basePath: string; name: string } | undefined {
  const marker = `${CHUNK_DIR_SUFFIX}/`;
  const index = remotePath.lastIndexOf(marker);
  if (index <= 0) {
    return undefined;
  }
  const name = remotePath.slice(index + marker.length);
  if (!name || name.includes('/')) {
    return undefined;
  }
  return { basePath: remotePath.slice(0, index), name };
}

/** Comprime e divide um conteúdo grande. Retorna os arquivos a gravar (caminhos completos). */
export function encodeChunked(remotePath: string, content: Buffer): { files: { path: string; content: Buffer }[]; manifest: ChunkManifest } {
  const compressed = zlib.gzipSync(content, { level: 6 });
  const dir = chunkDirFor(remotePath);
  const files: { path: string; content: Buffer }[] = [];
  const parts: string[] = [];
  for (let offset = 0, i = 0; offset < compressed.length || i === 0; offset += PART_SIZE_BYTES, i++) {
    const name = `part-${String(i).padStart(3, '0')}.gz`;
    parts.push(name);
    files.push({ path: dir + name, content: compressed.subarray(offset, offset + PART_SIZE_BYTES) });
  }
  const manifest: ChunkManifest = { version: 1, encoding: 'gzip', size: content.length, sha: gitBlobSha(content), parts };
  files.unshift({ path: dir + CHUNK_MANIFEST, content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') });
  return { files, manifest };
}

/** Remonta o conteúdo original a partir das partes, conferindo tamanho e sha. */
export function decodeChunked(manifest: ChunkManifest, parts: Buffer[]): Buffer {
  let content: Buffer;
  try {
    // O limite impede que um .gz adulterado no remoto ("bomba de descompressão") esgote a memória.
    content = zlib.gunzipSync(Buffer.concat(parts), { maxOutputLength: Math.max(1, manifest.size) });
  } catch (err) {
    throw new Error(t('split file on the remote could not be decompressed ({0})', (err as Error).message));
  }
  if (content.length !== manifest.size || gitBlobSha(content) !== manifest.sha) {
    throw new Error(t('split file on the remote is incomplete or corrupted (sha mismatch)'));
  }
  return content;
}

/** Tamanho máximo aceito para um arquivo dividido (o mesmo limite do envio). */
export const MAX_CHUNKED_FILE_BYTES = 1024 * 1024 * 1024;
/** gzip pode ficar um pouco maior que a entrada em dados incompressíveis; folga generosa. */
const MAX_PARTS = Math.ceil((MAX_CHUNKED_FILE_BYTES * 1.01) / PART_SIZE_BYTES) + 1;

export function parseManifest(raw: Buffer): ChunkManifest {
  const value = JSON.parse(raw.toString('utf8')) as ChunkManifest;
  if (
    !value ||
    value.version !== 1 ||
    value.encoding !== 'gzip' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > MAX_CHUNKED_FILE_BYTES ||
    typeof value.sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.sha) ||
    !Array.isArray(value.parts) ||
    value.parts.length === 0 ||
    value.parts.length > MAX_PARTS ||
    !value.parts.every((p) => typeof p === 'string' && /^part-\d{3,}\.gz$/.test(p))
  ) {
    throw new Error(t('invalid split-file manifest'));
  }
  return value;
}
