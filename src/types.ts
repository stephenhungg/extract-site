export interface ExtractOptions {
  url: string;
  outDir: string;
  name: string;
  headless: boolean;
  viewports: Viewport[];
}

export interface Viewport {
  name: 'desktop' | 'tablet' | 'mobile';
  width: number;
  height: number;
}

export interface AnimatedElement {
  selector: string;
  tag: string;
  classes: string[];
  text?: string;
  framerName?: string;
  // bbox in document coordinates (top + scrollY); used to link to sections.
  bbox?: { x: number; y: number; w: number; h: number };
  // CSS-derived
  cssTransition?: string;
  cssAnimation?: string;
  cssTransitionProperty?: string;
  cssTimingFunction?: string;
  cssDuration?: string;
  cssDelay?: string;
  // CDP-captured
  cdpAnimations?: CDPAnimation[];
  // Framer-motion (from data attrs / fiber walk)
  framerMotion?: {
    transition?: any;
    animate?: any;
    initial?: any;
    variants?: any;
    whileHover?: any;
    whileInView?: any;
  };
  // v0.4: linked + classified
  sectionSlug?: string;
  sectionIndex?: number;
  classification?: AnimationKind[];
}

// Heuristic taxonomy. An element can have multiple tags (e.g. fade-up = fade + slide-up).
export type AnimationKind =
  | 'fade'
  | 'slide-up'
  | 'slide-down'
  | 'slide-left'
  | 'slide-right'
  | 'scale'
  | 'rotate'
  | 'parallax'
  | 'sticky'
  | 'marquee'
  | 'char-stagger'
  | 'sibling-stagger'
  | 'hover-only'
  | 'scroll-linked'
  | 'unclassified';

export interface CDPAnimation {
  id: string;
  type: 'CSSTransition' | 'CSSAnimation' | 'WebAnimation';
  duration: number;
  delay: number;
  easing: string;
  iterations: number;
  keyframes?: Array<{ offset: number; easing?: string; computedOffset?: number }>;
  // v0.4 — resolved post-capture from backendNodeId
  backendNodeId?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  tag?: string;
  framerName?: string;
  text?: string;
  sectionSlug?: string;
  classification?: AnimationKind[];
}

export interface HoverState {
  selector: string;
  framerName?: string;
  sectionSlug?: string;
  bbox: { x: number; y: number; w: number; h: number };
  text?: string;
  // Style diffs, only the keys that changed
  delta: Record<string, { from: string; to: string }>;
  // Transition props on the element so the rebuild knows the timing.
  transition?: string;
  duration?: string;
  easing?: string;
  // cs-id of the element that ACTUALLY changed (often a descendant of selector
  // — framer's whileHover lands on a child like a chevron icon, not the link)
  targetCsId?: string;
}

export interface DetectedStack {
  framework?: 'next' | 'react' | 'svelte' | 'vue' | 'unknown';
  framerMotion: boolean;
  framer: boolean; // built with framer.com
  webflow: boolean;
  lenis: boolean;
  gsap: boolean;
  three: boolean;
  splineRuntime: boolean;
  notes: string[];
}

export interface DesignTokens {
  colors: { name: string; value: string; usage: number }[];
  typography: {
    fontFamilies: { family: string; usage: number }[];
    sizes: { value: string; usage: number }[];
    weights: { value: string; usage: number }[];
    lineHeights: { value: string; usage: number }[];
  };
  spacing: { value: string; usage: number }[];
  radii: { value: string; usage: number }[];
  shadows: { value: string; usage: number }[];
}

export interface SectionInfo {
  index: number;
  slug: string;
  selector: string;
  bbox: { x: number; y: number; width: number; height: number };
  tag: string;
  textPreview: string;
}

export interface AssetManifestEntry {
  originalUrl: string;
  localPath: string;
  type: 'image' | 'video' | 'font' | 'audio' | 'other';
  bytes: number;
  mime: string;
  // Magic-byte validated. `format` is the canonical detected format, `ok`
  // is false if bytes were truncated / corrupt / didn't match any known
  // signature (in that case localPath points into assets/_failed/).
  format?: string;
  ok?: boolean;
  failReason?: string;
  // Section slugs that referenced this asset (filled in later).
  usedIn?: string[];
}

export interface Meta {
  url: string;
  capturedAt: string;
  name: string;
  viewports: Viewport[];
  pageTitle: string;
  stack: DetectedStack;
  sectionCount: number;
  animationCount: number;
  assetCount: number;
}
