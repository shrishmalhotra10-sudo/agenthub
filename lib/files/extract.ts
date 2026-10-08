import 'server-only';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_STORED_TEXT = 200_000; // characters kept per file

export type FileKind = 'pdf' | 'docx' | 'image' | 'text';

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Plain-text and code files we read as text.
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'toml', 'ini', 'log',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'html', 'css', 'scss',
  'vue', 'svelte', 'dart', 'r', 'lua', 'pl',
]);

/** Decide what kind of file this is from its extension. Null = not supported. */
export function classify(filename: string): { kind: FileKind; mediaType: string } | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return { kind: 'pdf', mediaType: 'application/pdf' };
  if (ext === 'docx') {
    return {
      kind: 'docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }
  if (IMAGE_TYPES[ext]) return { kind: 'image', mediaType: IMAGE_TYPES[ext] };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: 'text', mediaType: 'text/plain' };
  return null;
}

/** Check the file's first bytes really match its claimed type (a renamed .exe isn't a .png). */
export function contentMatches(kind: FileKind, mediaType: string, bytes: Uint8Array): boolean {
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  switch (kind) {
    case 'pdf':
      return startsWith([0x25, 0x50, 0x44, 0x46]); // %PDF
    case 'docx':
      return startsWith([0x50, 0x4b, 0x03, 0x04]); // ZIP container
    case 'image':
      if (mediaType === 'image/png') return startsWith([0x89, 0x50, 0x4e, 0x47]);
      if (mediaType === 'image/jpeg') return startsWith([0xff, 0xd8, 0xff]);
      if (mediaType === 'image/gif') return startsWith([0x47, 0x49, 0x46, 0x38]);
      if (mediaType === 'image/webp') {
        return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8);
      }
      return false;
    case 'text':
      // Reject binary files: a NUL byte in the first 8 KB means it isn't text.
      return !bytes.subarray(0, 8192).includes(0);
  }
}

/** Pull readable text out of a file. Returns null for images or when nothing can be read. */
export async function extractText(kind: FileKind, bytes: Uint8Array): Promise<string | null> {
  // Give up on files that take too long to read (e.g. deliberately malformed ones).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 15_000);
  });
  try {
    return await Promise.race([extract(kind, bytes), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function extract(kind: FileKind, bytes: Uint8Array): Promise<string | null> {
  let text: string | null = null;
  try {
    if (kind === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const result = await extractPdfText(pdf, { mergePages: true });
      text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
    } else if (kind === 'docx') {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      text = result.value;
    } else if (kind === 'text') {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  } catch (err) {
    console.error('[extract] failed', kind, err);
    return null;
  }
  text = text?.trim() ?? null;
  if (!text) return null;
  return text.length > MAX_STORED_TEXT ? text.slice(0, MAX_STORED_TEXT) : text;
}
