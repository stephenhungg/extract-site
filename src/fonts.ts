import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

export async function generateFontFaceCSS(outDir: string): Promise<string[]> {
  const fontsDir = join(outDir, 'assets', 'fonts');
  let files: string[] = [];
  try {
    files = await readdir(fontsDir);
  } catch {
    return [];
  }
  const fonts = files.filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
  if (!fonts.length) return [];

  // Group by family guess (best-effort from filename)
  const byFamily = new Map<string, string[]>();
  for (const f of fonts) {
    const family = guessFamily(f);
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family)!.push(f);
  }

  const lines: string[] = ['/* Auto-generated @font-face from captured fonts */\n'];
  for (const [family, fs] of byFamily) {
    for (const f of fs) {
      const ext = f.split('.').pop()!.toLowerCase();
      const format = ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : ext === 'ttf' ? 'truetype' : 'opentype';
      lines.push(`@font-face {`);
      lines.push(`  font-family: "${family}";`);
      lines.push(`  src: url("../assets/fonts/${f}") format("${format}");`);
      lines.push(`  font-display: swap;`);
      lines.push(`}`);
      lines.push('');
    }
  }
  await mkdir(join(outDir, 'tokens'), { recursive: true });
  await writeFile(join(outDir, 'tokens', 'fonts.css'), lines.join('\n'), 'utf8');
  console.log(`  🔤 fonts.css with ${fonts.length} font files across ${byFamily.size} families`);
  return fonts;
}

function guessFamily(filename: string): string {
  // Strip hash prefix (xxxxx-realname.woff2) and version suffixes
  const stripped = basename(filename).replace(/^[a-f0-9]{8}-/i, '').replace(/\.\w+$/, '');
  // Heuristic: take before first hyphen if it looks like a hash
  const parts = stripped.split('-');
  // Common: "Inter-roman.var" or "PlayfairDisplay-Regular"
  let name = parts[0];
  // Insert spaces for CamelCase
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return name || 'Custom Font';
}
