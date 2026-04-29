import { Page, Request } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { AssetManifestEntry, Viewport } from './types.ts';

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

      const ext = extractExt(url, mime);
      const hash = createHash('md5').update(url).digest('hex').slice(0, 8);
      const safeName = sanitize(new URL(url).pathname.split('/').pop() || 'asset') + (ext ? '' : '');
      const filename = `${hash}-${safeName}${ext && !safeName.endsWith(ext) ? ext : ''}`;
      const dir = join(outDir, 'assets', bucket === 'image' ? 'images' : bucket === 'video' ? 'videos' : bucket === 'font' ? 'fonts' : 'audio');
      await mkdir(dir, { recursive: true });
      const localPath = join(dir, filename);
      await writeFile(localPath, buf);
      manifest.push({ originalUrl: url, localPath, type: bucket, bytes: buf.length, mime });
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
      console.log(`  🎁 ${manifest.length} assets harvested`);
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
