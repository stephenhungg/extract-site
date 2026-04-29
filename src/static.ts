import { Page, Request } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { AssetManifestEntry, Viewport } from './types.ts';
import { validateAsset } from './validate.ts';

export async function autoScroll(page: Page, opts: { stepPx?: number; pauseMs?: number } = {}) {
  const stepPx = opts.stepPx ?? 600;
  const pauseMs = opts.pauseMs ?? 200;
  await page.evaluate(
    async ({ stepPx, pauseMs }) => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const id = setInterval(() => {
          window.scrollBy(0, stepPx);
          y += stepPx;
          if (y >= document.documentElement.scrollHeight) {
            clearInterval(id);
            window.scrollTo(0, 0);
            setTimeout(resolve, 500);
          }
        }, pauseMs);
      });
    },
    { stepPx, pauseMs }
  );
}

export async function takeFullScreenshots(page: Page, outDir: string, viewports: Viewport[]) {
  await mkdir(join(outDir, 'screenshots'), { recursive: true });
  const results: string[] = [];
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(800);
    const path = join(outDir, 'screenshots', `${vp.name}-full.png`);
    await page.screenshot({ path, fullPage: true });
    results.push(path);
    console.log(`  📸 ${vp.name} full page`);
  }
  return results;
}

export async function dumpFullDOM(page: Page, outDir: string) {
  await mkdir(join(outDir, 'dom'), { recursive: true });
  const html = await page.content();
  const path = join(outDir, 'dom', 'full.html');
  await writeFile(path, html, 'utf8');
  console.log('  💾 full.html');
  return path;
}

export interface AssetCollector {
  manifest: AssetManifestEntry[];
  attach: (req: Request) => void;
  finalize: () => Promise<void>;
}

export function createAssetCollector(page: Page, outDir: string): AssetCollector {
  const manifest: AssetManifestEntry[] = [];
  const seen = new Set<string>();

  page.on('response', async (response) => {
    try {
      const req = response.request();
      const url = req.url();
      if (seen.has(url)) return;
      const type = req.resourceType();
      const mime = (response.headers()['content-type'] || '').split(';')[0].trim();
      let bucket: AssetManifestEntry['type'] | null = null;
      if (type === 'image' || mime.startsWith('image/')) bucket = 'image';
      else if (type === 'media' || mime.startsWith('video/')) bucket = 'video';
      else if (type === 'font' || mime.startsWith('font/') || /\.(woff2?|ttf|otf)(\?|$)/i.test(url))
        bucket = 'font';
      else if (mime.startsWith('audio/')) bucket = 'audio';
      if (!bucket) return;

      const buf = await response.body().catch(() => null);
      if (!buf) return;

      // Magic-byte validate. The detected ext beats both URL and mime —
      // framer often serves transcoded bytes (jpg url → webp body) and a
      // mismatched extension breaks downstream Read/Anthropic API calls.
      const v = validateAsset(buf, url);
      const fallbackExt = extractExt(url, mime);
      const finalExt = v.ext || fallbackExt;
      const hash = createHash('md5').update(url).digest('hex').slice(0, 8);
      const baseName = sanitize(new URL(url).pathname.split('/').pop() || 'asset').replace(/\.[a-z0-9]+$/i, '');
      const filename = `${hash}-${baseName}${finalExt}`;

      const bucketDir = bucket === 'image' ? 'images' : bucket === 'video' ? 'videos' : bucket === 'font' ? 'fonts' : 'audio';
      const okDir = join(outDir, 'assets', bucketDir);
      const failDir = join(outDir, 'assets', '_failed', bucketDir);
      const targetDir = v.ok ? okDir : failDir;
      await mkdir(targetDir, { recursive: true });
      const localPath = join(targetDir, filename);
      await writeFile(localPath, buf);

      if (!v.ok) {
        console.warn(`  ⚠️  invalid ${bucket} (${v.format}): ${v.reason} — quarantined: ${filename}`);
      }

      manifest.push({
        originalUrl: url,
        localPath,
        type: bucket,
        bytes: buf.length,
        mime,
        format: v.format,
        ok: v.ok,
        ...(v.reason ? { failReason: v.reason } : {}),
      });
      seen.add(url);
    } catch {
      // ignore — assets that fail are not the end of the world
    }
  });

  return {
    manifest,
    attach: () => {},
    finalize: async () => {
      await mkdir(join(outDir, 'assets'), { recursive: true });
      await writeFile(
        join(outDir, 'assets', 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8'
      );
      const failed = manifest.filter((m) => m.ok === false);
      const ok = manifest.length - failed.length;
      console.log(`  🎁 ${ok} valid + ${failed.length} quarantined = ${manifest.length} assets`);
      if (failed.length) {
        const lines: string[] = [
          '# Quarantined assets',
          '',
          'These responses failed magic-byte validation. Anything in here is unsafe',
          'to feed downstream tools (image readers, the Anthropic API, etc.) and is',
          'kept only for forensic purposes — do NOT reference these from a rebuild.',
          '',
        ];
        for (const f of failed) {
          lines.push(`- \`${f.localPath.split('/assets/')[1]}\` — ${f.format} (${f.bytes}b) — ${f.failReason}`);
          lines.push(`  url: ${f.originalUrl}`);
        }
        await mkdir(join(outDir, 'assets', '_failed'), { recursive: true });
        await writeFile(join(outDir, 'assets', '_failed', 'README.md'), lines.join('\n'), 'utf8');
      }
    },
  };
}

function extractExt(url: string, mime: string): string {
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  if (fromUrl) return fromUrl;
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'font/ttf': '.ttf',
    'application/font-woff2': '.woff2',
  };
  return map[mime] || '';
}

function sanitize(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}
