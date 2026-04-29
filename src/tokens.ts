import { Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesignTokens } from './types.ts';

export async function extractTokens(page: Page): Promise<DesignTokens> {
  return await page.evaluate(() => {
    const colors = new Map<string, number>();
    const fontFamilies = new Map<string, number>();
    const fontSizes = new Map<string, number>();
    const fontWeights = new Map<string, number>();
    const lineHeights = new Map<string, number>();
    const spacing = new Map<string, number>();
    const radii = new Map<string, number>();
    const shadows = new Map<string, number>();

    function bump(map: Map<string, number>, key: string) {
      if (!key) return;
      map.set(key, (map.get(key) ?? 0) + 1);
    }

    const all = document.querySelectorAll('*');
    let n = 0;
    for (const el of Array.from(all)) {
      if (n++ > 8000) break;
      const cs = getComputedStyle(el);
      const color = cs.color;
      const bg = cs.backgroundColor;
      const border = cs.borderColor;
      if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'rgb(0, 0, 0)') bump(colors, color);
      if (bg && bg !== 'rgba(0, 0, 0, 0)') bump(colors, bg);
      if (border && border !== 'rgba(0, 0, 0, 0)' && border !== 'rgb(0, 0, 0)') bump(colors, border);
      bump(fontFamilies, cs.fontFamily);
      bump(fontSizes, cs.fontSize);
      bump(fontWeights, cs.fontWeight);
      bump(lineHeights, cs.lineHeight);
      for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'marginTop', 'marginBottom']) {
        const v = (cs as any)[p];
        if (v && v !== '0px' && v !== 'normal') bump(spacing, v);
      }
      if (cs.borderRadius && cs.borderRadius !== '0px') bump(radii, cs.borderRadius);
      if (cs.boxShadow && cs.boxShadow !== 'none') bump(shadows, cs.boxShadow);
    }

    const sortMap = (m: Map<string, number>) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([value, usage]) => ({ value, usage }));

    const namedColors = sortMap(colors).map((c, i) => ({
      name: `color-${i + 1}`,
      value: c.value,
      usage: c.usage,
    }));

    return {
      colors: namedColors,
      typography: {
        fontFamilies: sortMap(fontFamilies).map((x) => ({ family: x.value, usage: x.usage })),
        sizes: sortMap(fontSizes),
        weights: sortMap(fontWeights),
        lineHeights: sortMap(lineHeights),
      },
      spacing: sortMap(spacing),
      radii: sortMap(radii),
      shadows: sortMap(shadows),
    };
  });
}

export async function writeTokenArtifacts(outDir: string, tokens: DesignTokens) {
  await mkdir(join(outDir, 'tokens'), { recursive: true });
  await writeFile(
    join(outDir, 'tokens', 'colors.json'),
    JSON.stringify(tokens.colors, null, 2),
    'utf8'
  );
  await writeFile(
    join(outDir, 'tokens', 'typography.json'),
    JSON.stringify(tokens.typography, null, 2),
    'utf8'
  );
  await writeFile(
    join(outDir, 'tokens', 'spacing.json'),
    JSON.stringify({ spacing: tokens.spacing, radii: tokens.radii, shadows: tokens.shadows }, null, 2),
    'utf8'
  );

  const css = generateTokensCSS(tokens);
  await writeFile(join(outDir, 'tokens', 'tokens.css'), css, 'utf8');
  console.log(`  🎨 ${tokens.colors.length} colors, ${tokens.typography.fontFamilies.length} fonts, ${tokens.spacing.length} spacing values`);
}

function generateTokensCSS(t: DesignTokens): string {
  const lines: string[] = [':root {'];
  t.colors.forEach((c, i) => lines.push(`  --${c.name}: ${c.value}; /* used ${c.usage}× */`));
  t.typography.fontFamilies.slice(0, 3).forEach((f, i) =>
    lines.push(`  --font-${i + 1}: ${f.family}; /* used ${f.usage}× */`)
  );
  t.typography.sizes.slice(0, 12).forEach((s, i) =>
    lines.push(`  --text-${i + 1}: ${s.value}; /* used ${s.usage}× */`)
  );
  t.spacing.slice(0, 16).forEach((s, i) =>
    lines.push(`  --space-${i + 1}: ${s.value}; /* used ${s.usage}× */`)
  );
  t.radii.slice(0, 6).forEach((r, i) =>
    lines.push(`  --radius-${i + 1}: ${r.value};`)
  );
  t.shadows.slice(0, 4).forEach((s, i) =>
    lines.push(`  --shadow-${i + 1}: ${s.value};`)
  );
  lines.push('}');
  return lines.join('\n');
}
