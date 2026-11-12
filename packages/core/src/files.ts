import type { FileRef } from './types';

// Files picked in a browser can't be stored as a path, so they are kept here, in memory, until the page closes.
const picked = new Map<string, Blob>();

export function rememberFile(id: string, file: Blob): void {
  picked.set(id, file);
}

export function recallFile(id: string): Blob | undefined {
  return picked.get(id);
}

const TYPES: Record<string, string> = {
  json: 'application/json', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', html: 'text/html', md: 'text/markdown',
  yaml: 'application/yaml', yml: 'application/yaml', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Content type from a file name; `application/octet-stream` when the ending isn't known. */
export function guessContentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

export function fileContentType(f: FileRef): string {
  return f.contentType || guessContentType(f.name);
}
