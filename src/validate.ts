// Asset validation: magic-byte sniffing so the file extension always matches
// the actual bytes. Prevents downstream tools (image readers, the Anthropic
// API, etc.) from choking on a .jpg that's actually webp, or a truncated
// download that masquerades as a valid image.

export type DetectedFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'avif'
  | 'gif'
  | 'svg'
  | 'mp4'
  | 'webm'
  | 'mov'
  | 'woff2'
  | 'woff'
  | 'ttf'
  | 'otf'
  | 'unknown';

export interface ValidationResult {
  format: DetectedFormat;
  ext: string; // canonical extension including leading "."
  ok: boolean; // true iff bytes look like a complete file of this format
  reason?: string; // why ok=false (e.g. "truncated jpeg", "empty body")
}

const MAGIC: { format: DetectedFormat; ext: string; check: (b: Buffer) => boolean }[] = [
  { format: 'jpeg', ext: '.jpg', check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { format: 'png', ext: '.png', check: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { format: 'gif', ext: '.gif', check: (b) => b.length >= 6 && b.slice(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null },
  { format: 'webp', ext: '.webp', check: (b) => b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { format: 'avif', ext: '.avif', check: (b) => b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp' && /avif|avis|heic|heix|mif1/.test(b.slice(8, 12).toString('ascii')) },
  { format: 'mp4', ext: '.mp4', check: (b) => b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp' && /mp4|isom|iso2|dash/.test(b.slice(8, 12).toString('ascii')) },
  { format: 'mov', ext: '.mov', check: (b) => b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp' && /qt/.test(b.slice(8, 12).toString('ascii')) },
  { format: 'webm', ext: '.webm', check: (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { format: 'woff2', ext: '.woff2', check: (b) => b.length >= 4 && b.slice(0, 4).toString('ascii') === 'wOF2' },
  { format: 'woff', ext: '.woff', check: (b) => b.length >= 4 && b.slice(0, 4).toString('ascii') === 'wOFF' },
  { format: 'ttf', ext: '.ttf', check: (b) => b.length >= 4 && b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00 },
  { format: 'otf', ext: '.otf', check: (b) => b.length >= 4 && b.slice(0, 4).toString('ascii') === 'OTTO' },
];

function looksLikeSvg(b: Buffer): boolean {
  if (b.length < 5) return false;
  // Skip leading whitespace + optional BOM
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && b[i] <= 0x20) i++;
  const head = b.slice(i, Math.min(i + 512, b.length)).toString('utf8').toLowerCase();
  return head.startsWith('<?xml') ? head.includes('<svg') : head.startsWith('<svg');
}

// Cheap sanity check that an image isn't truncated. We don't need a full
// parser — just verify trailers exist for the formats where it's easy.
function isComplete(format: DetectedFormat, b: Buffer): { ok: boolean; reason?: string } {
  if (b.length === 0) return { ok: false, reason: 'empty body' };
  switch (format) {
    case 'jpeg': {
      // valid jpeg ends with FF D9
      if (b.length < 4) return { ok: false, reason: 'truncated jpeg (too small)' };
      if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) {
        return { ok: false, reason: 'truncated jpeg (missing EOI marker)' };
      }
      return { ok: true };
    }
    case 'png': {
      // valid png ends with IEND chunk: 49 45 4E 44 AE 42 60 82
      if (b.length < 12) return { ok: false, reason: 'truncated png (too small)' };
      const tail = b.slice(b.length - 8);
      if (tail[0] !== 0x49 || tail[1] !== 0x45 || tail[2] !== 0x4e || tail[3] !== 0x44) {
        return { ok: false, reason: 'truncated png (missing IEND chunk)' };
      }
      return { ok: true };
    }
    case 'gif': {
      // valid gif ends with 0x3B
      if (b[b.length - 1] !== 0x3b) return { ok: false, reason: 'truncated gif' };
      return { ok: true };
    }
    default:
      // For webp/avif/video/fonts/svg, require a sensible minimum size.
      if (b.length < 32) return { ok: false, reason: 'too small to be a real asset' };
      return { ok: true };
  }
}

export function validateAsset(buf: Buffer, urlOrName: string): ValidationResult {
  if (buf.length === 0) return { format: 'unknown', ext: '', ok: false, reason: 'empty body' };

  for (const m of MAGIC) {
    if (m.check(buf)) {
      const completeness = isComplete(m.format, buf);
      return { format: m.format, ext: m.ext, ok: completeness.ok, reason: completeness.reason };
    }
  }
  if (looksLikeSvg(buf)) {
    return { format: 'svg', ext: '.svg', ok: true };
  }
  return {
    format: 'unknown',
    ext: '',
    ok: false,
    reason: `no magic-byte match (first 8 bytes: ${buf.slice(0, 8).toString('hex')})`,
  };
}
