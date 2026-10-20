/**
 * Printmaking processing library — technique-accurate canvas implementation.
 *
 * Each style processor models the physical constraints of the real technique:
 *   woodblock  — local tone, connected shapes and tapered gouges → independent binary key plate
 *   etching    — gradient-following cross-contour hatching, density ∝ darkness
 *   screenprint— k-means posterisation with ink-saturated color boosting
 *   lithograph — multi-scale stone grain, warm tonal range
 *
 * FUTURE API SWAP: Replace the switch block in `processImage` with a fetch()
 * call to your AI backend. All callsites stay identical.
 */

import { renderWoodcut, type WoodcutStyle } from './woodcut';
import { recognizeSubjects, hasPeople, type SubjectRegions, type SubjectStatus } from './subjects';
import { separateNaturalColors, type InkRole } from './protected-colors';

export type PrintStyle = 'woodblock' | 'screenprint' | 'etching' | 'lithograph';
export type DifficultyLevel = 'Easy' | 'Medium' | 'Advanced' | 'Hard';

export interface ProcessConfig {
  style: PrintStyle;
  colorCount: number; // Total printing plates, including the black key plate.
  blackStyle?: WoodcutStyle;
  protectPeople?: boolean;
  subjectRegions?: SubjectRegions;
  contrast: number;   // 0–100
  lineWeight: number; // 0–100
}

export interface Plate {
  id: number;
  kind: 'color' | 'black';
  role?: InkRole;
  width: number;
  height: number;
  color: string;
  colorName: string;
  maskDataUrl: string;
  printOrder: number;
  coveragePercent: number;
  difficulty: DifficultyLevel;
  difficultyScore: number; // 0–100
}

export interface ProcessResult {
  processedImageUrl: string;
  compositeImageUrl: string | null;
  plates: Plate[];
  overallDifficulty: DifficultyLevel;
  feasibilityNotes: string[];
  subjectRegions?: SubjectRegions;
  subjectStatus?: SubjectStatus;
}

export interface GuideStep {
  step: number;
  title: string;
  detail: string;
  plateRef?: number;
  tip?: string;
}

// ─── Primitives ───────────────────────────────────────────────────────────────

type RGB = [number, number, number];

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function luminance([r, g, b]: RGB): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function sqDist(a: RGB, b: RGB): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

// Deterministic positional noise — avoids seeding issues
function noise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// ─── Image Utilities ──────────────────────────────────────────────────────────

interface CanvasResult {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  imageData: ImageData;
}

async function loadImage(src: string, maxDim = 640): Promise<CanvasResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > maxDim || h > maxDim) {
        const r = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * r);
        h = Math.round(h * r);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ canvas, ctx, imageData: ctx.getImageData(0, 0, w, h) });
    };
    img.onerror = reject;
    img.src = src;
  });
}

function toGray(d: Uint8ClampedArray): Uint8Array {
  const g = new Uint8Array(d.length >> 2);
  for (let i = 0; i < d.length; i += 4)
    g[i >> 2] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  return g;
}

function boxBlur(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          s += src[(y + dy) * w + (x + dx)];
      out[y * w + x] = Math.round(s / 9);
    }
  }
  return out;
}

function applyContrast(src: Uint8Array, contrast: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const c = (contrast - 50) * 2.2;
  const f = (259 * (c + 255)) / (255 * (259 - c + 0.001));
  for (let i = 0; i < src.length; i++) out[i] = clamp(f * (src[i] - 128) + 128);
  return out;
}

// Sobel gradient magnitude (unnormalised)
function sobelEdges(gray: Uint8Array, w: number, h: number): Float32Array {
  const edges = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)]
        - 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)]
        - gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)];
      const gy =
        gray[(y - 1) * w + (x - 1)] + 2 * gray[(y - 1) * w + x] + gray[(y - 1) * w + (x + 1)]
        - gray[(y + 1) * w + (x - 1)] - 2 * gray[(y + 1) * w + x] - gray[(y + 1) * w + (x + 1)];
      edges[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return edges;
}

// Edge magnitude threshold at given percentile
function edgePercentileThreshold(edges: Float32Array, pct: number): number {
  let maxE = 0;
  for (const e of edges) if (e > maxE) maxE = e;
  if (maxE === 0) return 0;
  const hist = new Uint32Array(256);
  for (const e of edges) hist[Math.min(255, Math.round(e / maxE * 255))]++;
  const target = Math.floor(edges.length * pct);
  let count = 0;
  for (let i = 0; i < 256; i++) {
    count += hist[i];
    if (count >= target) return (i / 255) * maxE;
  }
  return maxE;
}

function computeEdgeDensity(edges: Float32Array, threshold: number): number {
  let count = 0;
  for (const e of edges) if (e > threshold) count++;
  return count / edges.length;
}

function computeAvgBrightness(gray: Uint8Array): number {
  let s = 0;
  for (const v of gray) s += v;
  return s / gray.length;
}

// ─── Color Utilities ──────────────────────────────────────────────────────────

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2 = (p: number, q: number, t: number) => {
    t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2(p, q, h + 1 / 3) * 255),
    Math.round(hue2(p, q, h) * 255),
    Math.round(hue2(p, q, h - 1 / 3) * 255),
  ];
}

/**
 * Push centroid colors toward printmaking ink primaries.
 * Dark → rich printing black; light → warm paper; mid → full-saturation ink.
 */
function boostPrintColor(rgb: RGB): RGB {
  const [h, s, l] = rgbToHsl(rgb);
  if (l < 0.13) return [18, 14, 12]; // printing black
  if (l > 0.87) return [244, 240, 232]; // warm paper
  // Aggressive saturation boost — unmixed printing inks are vivid
  const newS = Math.min(1.0, s * 2.2 + 0.18);
  // Push lightness away from midpoint for graphic contrast
  const newL = l < 0.42
    ? Math.max(0.1, l * 0.72)
    : l > 0.58
      ? Math.min(0.9, l * 1.06 + 0.06)
      : l;
  return hslToRgb([h, newS, newL]);
}

// ─── CIE Lab Color Space ──────────────────────────────────────────────────────
// Lab is perceptually uniform: equal Lab distances = equal perceived color differences.
// This prevents k-means from confusing perceptually distinct hues (e.g. green vs yellow)
// that happen to be close in RGB space.

type Lab = [number, number, number];

function linearizeGamma(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbToLab([r, g, b]: RGB): Lab {
  const rl = linearizeGamma(r), gl = linearizeGamma(g), bl = linearizeGamma(b);
  // Linear RGB → XYZ (D65 illuminant)
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;
  // XYZ → Lab
  const f = (t: number) => t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116;
  const fx = f(x / 0.95047), fy = f(y / 1.00000), fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116;
  const f3 = (t: number) => t > 0.206897 ? t ** 3 : (t - 16 / 116) / 7.787;
  const x = f3(a / 500 + fy) * 0.95047;
  const y = f3(fy) * 1.00000;
  const z = f3(fy - b / 200) * 1.08883;
  // XYZ → Linear RGB
  const rl =  3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const bl =  0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const gamma = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return [clamp(gamma(rl) * 255), clamp(gamma(gl) * 255), clamp(gamma(bl) * 255)];
}

function sqDistLab(a: Lab, b: Lab): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

// ─── K-Means Clustering ────────────────────────────────────────────────────────

function colorRandom(pixels: RGB[], count: number): () => number {
  let state = (2166136261 ^ count) >>> 0;
  for (const pixel of pixels) for (const channel of pixel) state = Math.imul(state ^ channel, 16777619) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

function kMeansCluster(pixels: RGB[], k: number): RGB[] {
  if (pixels.length <= k) return pixels.slice(0, k);
  const random = colorRandom(pixels, k);

  // k-means++ seed
  const centroids: RGB[] = [[...pixels[Math.floor(random() * pixels.length)]]];
  while (centroids.length < k) {
    const dists = pixels.map(p => Math.min(...centroids.map(c => sqDist(p, c))));
    const total = dists.reduce((s, d) => s + d, 0);
    if (total === 0) { centroids.push([...pixels[Math.floor(random() * pixels.length)]]); continue; }
    let r = random() * total;
    let pushed = false;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { centroids.push([...pixels[i]]); pushed = true; break; }
    }
    if (!pushed) centroids.push([...pixels[pixels.length - 1]]);
  }

  for (let iter = 0; iter < 30; iter++) {
    const clusters: RGB[][] = Array.from({ length: k }, () => []);
    for (const p of pixels) {
      let minD = Infinity, ni = 0;
      for (let j = 0; j < k; j++) {
        const d = sqDist(p, centroids[j]);
        if (d < minD) { minD = d; ni = j; }
      }
      clusters[ni].push(p);
    }
    let moved = false;
    for (let j = 0; j < k; j++) {
      if (!clusters[j].length) continue;
      const nc: RGB = [
        Math.round(clusters[j].reduce((s, p) => s + p[0], 0) / clusters[j].length),
        Math.round(clusters[j].reduce((s, p) => s + p[1], 0) / clusters[j].length),
        Math.round(clusters[j].reduce((s, p) => s + p[2], 0) / clusters[j].length),
      ];
      if (sqDist(nc, centroids[j]) > 1) moved = true;
      centroids[j] = nc;
    }
    if (!moved) break;
  }
  return centroids;
}

// k-means++ in CIE Lab space — respects perceptual hue boundaries
function kMeansClusterLab(pixels: RGB[], k: number): RGB[] {
  if (pixels.length <= k) return pixels.slice(0, k);
  const random = colorRandom(pixels, k);

  const labPixels: Lab[] = pixels.map(rgbToLab);

  // k-means++ seeding in Lab space
  const centroids: Lab[] = [[...labPixels[Math.floor(random() * labPixels.length)]]];
  while (centroids.length < k) {
    const dists = labPixels.map(p => Math.min(...centroids.map(c => sqDistLab(p, c))));
    const total = dists.reduce((s, d) => s + d, 0);
    if (total === 0) { centroids.push([...labPixels[Math.floor(random() * labPixels.length)]]); continue; }
    let r = random() * total;
    let pushed = false;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { centroids.push([...labPixels[i]]); pushed = true; break; }
    }
    if (!pushed) centroids.push([...labPixels[labPixels.length - 1]]);
  }

  for (let iter = 0; iter < 30; iter++) {
    const clusters: Lab[][] = Array.from({ length: k }, () => []);
    for (const p of labPixels) {
      let minD = Infinity, ni = 0;
      for (let j = 0; j < k; j++) {
        const d = sqDistLab(p, centroids[j]);
        if (d < minD) { minD = d; ni = j; }
      }
      clusters[ni].push(p);
    }
    let moved = false;
    for (let j = 0; j < k; j++) {
      if (!clusters[j].length) continue;
      const n = clusters[j].length;
      const nc: Lab = [
        clusters[j].reduce((s, p) => s + p[0], 0) / n,
        clusters[j].reduce((s, p) => s + p[1], 0) / n,
        clusters[j].reduce((s, p) => s + p[2], 0) / n,
      ];
      if (sqDistLab(nc, centroids[j]) > 0.1) moved = true;
      centroids[j] = nc;
    }
    if (!moved) break;
  }

  return centroids.map(labToRgb);
}

function samplePixels(data: Uint8ClampedArray, step = 5): RGB[] {
  const out: RGB[] = [];
  for (let i = 0; i < data.length; i += 4 * step)
    out.push([data[i], data[i + 1], data[i + 2]]);
  return out;
}

// ─── Style Processors ─────────────────────────────────────────────────────────

/**
 * Screenprint / serigraphy:
 * Physical constraint — each ink layer is a flat, opaque wash of one colour.
 * Technique demands graphic simplicity; fine gradients are unworkable.
 * Result: bold poster-like posterisation with ink-primary colours.
 */
function processScreenprint(imageData: ImageData, colorCount: number, contrast: number): void {
  const d = imageData.data;

  // Slightly boost contrast before clustering to sharpen colour boundaries
  const gray = applyContrast(toGray(d), contrast);
  // Rebuild boosted RGBA for clustering input
  const boostedD = new Uint8ClampedArray(d);
  for (let i = 0; i < boostedD.length; i += 4) {
    const c = (contrast - 50) * 1.2;
    const f = (259 * (c + 255)) / (255 * (259 - c + 0.001));
    boostedD[i] = clamp(f * (boostedD[i] - 128) + 128);
    boostedD[i + 1] = clamp(f * (boostedD[i + 1] - 128) + 128);
    boostedD[i + 2] = clamp(f * (boostedD[i + 2] - 128) + 128);
  }

  const pixels = samplePixels(boostedD, 6);
  const centroids = kMeansClusterLab(pixels, colorCount);
  // Convert to printmaking-ink primaries
  const inkColors = centroids.map(boostPrintColor);
  void gray; // used indirectly above

  for (let i = 0; i < d.length; i += 4) {
    const p: RGB = [boostedD[i], boostedD[i + 1], boostedD[i + 2]];
    let minD = Infinity, ni = 0;
    for (let j = 0; j < centroids.length; j++) {
      const dist = sqDist(p, centroids[j]);
      if (dist < minD) { minD = dist; ni = j; }
    }
    d[i] = inkColors[ni][0]; d[i + 1] = inkColors[ni][1]; d[i + 2] = inkColors[ni][2];
    d[i + 3] = 255;
  }
  // Snap near-white pixels to clean paper — removes edge speckling in light areas
  for (let i = 0; i < d.length; i += 4) {
    if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 215) {
      d[i] = 244; d[i + 1] = 240; d[i + 2] = 232;
    }
  }
}

/**
 * Etching / intaglio:
 * Physical constraint — ink sits in acid-bitten grooves. The printmaker draws
 * lines that follow the form (cross-contour hatching).
 *
 * Algorithm: for each pixel, compute the local gradient direction. Lines run
 * perpendicular to the gradient (i.e., along iso-intensity contours).
 * Line spacing = f(brightness): dark areas → dense hatching; light → sparse.
 * Very dark areas get a second diagonal crosshatch layer.
 */
function processEtching(imageData: ImageData, lineWeight: number, contrast: number): void {
  const d = imageData.data;
  const { width: w, height: h } = imageData;

  let gray = toGray(d);
  gray = boxBlur(gray, w, h); // smooth before gradient computation
  gray = applyContrast(gray, contrast);

  // Spacing range based on lineWeight
  const minSpacing = Math.max(2, Math.round(3 + (100 - lineWeight) * 0.04));
  const maxSpacing = Math.max(minSpacing + 3, Math.round(14 + (100 - lineWeight) * 0.08));

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const g = gray[y * w + x];

      // Local gradient via central differences on the smoothed image
      const gx = (gray[y * w + (x + 1)] - gray[y * w + (x - 1)]) * 0.5;
      const gy = (gray[(y + 1) * w + x] - gray[(y - 1) * w + x]) * 0.5;
      const mag = Math.sqrt(gx * gx + gy * gy);

      // Gradient direction (fallback to horizontal in flat regions)
      const nx = mag > 4 ? gx / mag : 1;
      const ny = mag > 4 ? gy / mag : 0;

      // Coordinate along the gradient axis — pixels with equal proj lie on the
      // same contour line (perpendicular to gradient = along the form)
      const proj = x * nx + y * ny;

      // Line spacing scales with brightness: bright = wide spacing (few lines)
      const brightness = g / 255;
      const spacing = Math.round(minSpacing + (maxSpacing - minSpacing) * brightness);

      // Is this pixel on a primary hatch line?
      const lineCoord = proj - Math.floor(proj / spacing) * spacing;
      let isLine = lineCoord < 1.4 && g < 230;

      // Crosshatch for dark areas (second perpendicular family of lines)
      if (!isLine && g < 110) {
        const proj2 = x * (-ny) + y * nx;
        const spacing2 = Math.round(spacing * 1.45);
        const lc2 = proj2 - Math.floor(proj2 / spacing2) * spacing2;
        isLine = lc2 < 1.4;
      }

      // Triple hatch in very darkest areas
      if (!isLine && g < 55) {
        const proj3 = (x + y) * 0.707;
        const spacing3 = Math.round(spacing * 0.8);
        const lc3 = proj3 - Math.floor(proj3 / spacing3) * spacing3;
        isLine = lc3 < 1.2;
      }

      const pi = (y * w + x) * 4;
      if (isLine) {
        // Warm black — dense ink on pale paper
        d[pi] = clamp(g * 0.08); d[pi + 1] = clamp(g * 0.07); d[pi + 2] = clamp(g * 0.04);
      } else {
        // Aged parchment paper
        d[pi] = 252; d[pi + 1] = 248; d[pi + 2] = 238;
      }
      d[pi + 3] = 255;
    }
  }
}

/**
 * Lithograph:
 * Physical constraint — drawn with greasy crayon on limestone; chemical
 * process makes oil-bearing areas accept ink. Tonal range is wide but
 * the surface grain is always visible (stone or aluminium plate texture).
 * Warm tonal cast from traditional litho inks.
 */
function processLithograph(imageData: ImageData, contrast: number): void {
  const d = imageData.data;
  const { width: w, height: h } = imageData;

  let gray = toGray(d);
  gray = boxBlur(gray, w, h);
  gray = applyContrast(gray, contrast);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const g = gray[idx];

      // Multi-scale stone grain:
      //   fine = individual limestone crystal texture
      //   coarse = broader surface irregularity
      //   directional = stone-bed striation (slight horizontal bias)
      const fine = (noise(x * 6.1, y * 5.7) - 0.5) * 16;
      const coarse = (noise(x * 1.9, y * 1.4) - 0.5) * 10;
      const directional = (noise(x * 0.5 + y * 0.12, y * 0.9) - 0.5) * 7;

      const gv = clamp(g + fine + coarse + directional);

      // Warm litho ink cast: reds slightly warmer, blues slightly cooler
      const pi = idx * 4;
      d[pi] = clamp(gv * 1.03);
      d[pi + 1] = gv;
      d[pi + 2] = clamp(gv * 0.91);
      d[pi + 3] = 255;
    }
  }
}

// ─── Plate Separation ─────────────────────────────────────────────────────────

function guessColorName(rgb: RGB): string {
  const [r, g, b] = rgb;
  const lum = luminance(rgb);
  if (lum < 22) return 'Black Plate';
  if (lum > 232) return 'White Plate';
  const max = Math.max(r, g, b);
  const sat = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
  if (sat < 0.18) {
    return lum < 90 ? 'Dark Gray Plate' : lum < 170 ? 'Mid Gray Plate' : 'Light Gray Plate';
  }
  if (r === max && b < 100) return g < 120 ? 'Red Plate' : 'Orange Plate';
  if (g === max && r < 140) return 'Green Plate';
  if (b === max && r < 140) return 'Blue Plate';
  if (r > 180 && g > 160 && b < 90) return 'Yellow Plate';
  if (r > 140 && g < 90 && b > 140) return 'Purple Plate';
  if (r > 155 && g > 100 && b < 90) return 'Brown Plate';
  return 'Mixed Color Plate';
}

function plateDifficulty(coveragePercent: number, style: PrintStyle): { score: number; level: DifficultyLevel } {
  // Small coverage = many small isolated areas = harder to register/print
  let score = 50;
  if (coveragePercent < 5) score = 85;
  else if (coveragePercent < 12) score = 65;
  else if (coveragePercent > 45) score = 28;
  else score = 48;

  // Style modifier
  if (style === 'etching') score = Math.min(100, score + 12);
  else if (style === 'lithograph') score = Math.min(100, score + 8);
  else if (style === 'screenprint') score = Math.max(0, score - 8);

  const level: DifficultyLevel =
    score >= 78 ? 'Hard' : score >= 55 ? 'Advanced' : score >= 30 ? 'Medium' : 'Easy';
  return { score, level };
}

function createPlateMask(
  src: ImageData,
  assignCentroids: RGB[],
  displayColor: RGB,
  plateIdx: number,
  assignments?: Int16Array,
): string {
  const { width: w, height: h } = src;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const mask = ctx.createImageData(w, h);
  const s = src.data, m = mask.data;

  for (let i = 0; i < s.length; i += 4) {
    if (s[i + 3] === 0) continue;
    let ni = assignments?.[i / 4] ?? 0;
    if (!assignments) {
      const p: RGB = [s[i], s[i + 1], s[i + 2]];
      let minD = Infinity;
      for (let j = 0; j < assignCentroids.length; j++) {
        const d = sqDist(p, assignCentroids[j]);
        if (d < minD) { minD = d; ni = j; }
      }
    }
    if (ni === plateIdx) {
      m[i] = displayColor[0]; m[i + 1] = displayColor[1]; m[i + 2] = displayColor[2]; m[i + 3] = 255;
    } else {
      m[i + 3] = 0;
    }
  }

  ctx.putImageData(mask, 0, 0);
  return canvas.toDataURL('image/png');
}

function createClusterComposite(
  src: ImageData,
  assignCentroids: RGB[],
  displayColors: RGB[]
): string {
  const { width: w, height: h } = src;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  const s = src.data;
  const o = out.data;

  for (let i = 0; i < s.length; i += 4) {
    const p: RGB = [s[i], s[i + 1], s[i + 2]];
    let minD = Infinity;
    let ni = 0;
    for (let j = 0; j < assignCentroids.length; j++) {
      const d = sqDist(p, assignCentroids[j]);
      if (d < minD) { minD = d; ni = j; }
    }

    const color = displayColors[ni];
    o[i] = color[0];
    o[i + 1] = color[1];
    o[i + 2] = color[2];
    o[i + 3] = 255;
  }

  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
}

async function buildPlates(
  imageData: ImageData,
  colorCount: number,
  style: PrintStyle,
  keyData?: ImageData,
  regions?: SubjectRegions,
): Promise<{ plates: Plate[]; compositeImageUrl: string }> {
  const totalPlateCount = Math.max(2, Math.min(9, Math.round(colorCount)));
  const separateKey = style === 'woodblock' && keyData !== undefined;
  const colorPlateCount = totalPlateCount - (separateKey ? 1 : 0);
  const pixels = samplePixels(imageData.data, 4);
  const natural = separateKey ? separateNaturalColors(imageData, colorPlateCount, regions, kMeansClusterLab, rgbToLab) : undefined;
  const centroids = natural?.colors ?? kMeansClusterLab(pixels, colorPlateCount);

  // Sort light → dark (print order: light inks first)
  const sorted = natural ? centroids : [...centroids].sort((a, b) => luminance(b) - luminance(a));
  // The woodblock key plate comes from the carving pass, independently of color.
  const boldSorted: RGB[] = sorted.map((c, i) =>
    separateKey ? c : i === sorted.length - 1 ? [0, 0, 0] : boostPrintColor(c)
  );

  // Coverage
  const counts = new Array(colorPlateCount).fill(0);
  const total = imageData.data.length / 4;
  const s = imageData.data;
  for (let i = 0; i < s.length; i += 4) {
    if (natural) { const label = natural.assignments[i / 4]; if (label >= 0) counts[label]++; continue; }
    const p: RGB = [s[i], s[i + 1], s[i + 2]];
    let minD = Infinity, ni = 0;
    for (let j = 0; j < sorted.length; j++) {
      const d = sqDist(p, sorted[j]);
      if (d < minD) { minD = d; ni = j; }
    }
    counts[ni]++;
  }

  const plates: Plate[] = sorted.map((orig, idx) => {
    const cov = Math.round((counts[idx] / total) * 100);
    const { score, level } = plateDifficulty(cov, style);
    return {
      id: idx,
      kind: !separateKey && idx === sorted.length - 1 ? 'black' : 'color',
      role: natural?.roles[idx],
      width: imageData.width,
      height: imageData.height,
      color: toHex(boldSorted[idx]),
      colorName: !separateKey && idx === sorted.length - 1 ? 'Black Key Plate' : natural ? `${natural.roles[idx] === 'skin' ? 'Skin' : natural.roles[idx] === 'clothing' ? 'Clothing' : 'Background'} Ink ${String(idx + 1).padStart(2, '0')}` : `Color Plate ${String(idx + 1).padStart(2, '0')}`,
      maskDataUrl: createPlateMask(imageData, sorted, boldSorted[idx], idx, natural?.assignments),
      printOrder: idx + 1,
      coveragePercent: cov,
      difficulty: level,
      difficultyScore: score,
    };
  });

  if (separateKey) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d')!;
    const keyMask = ctx.createImageData(canvas.width, canvas.height);
    let printedPixels = 0;
    for (let i = 0; i < keyMask.data.length; i += 4) {
      if (keyData.data[i] < 128 && imageData.data[i + 3] > 0) {
        keyMask.data[i + 3] = 255;
        printedPixels++;
      }
    }
    ctx.putImageData(keyMask, 0, 0);
    const coveragePercent = Math.round(printedPixels / total * 100);
    const { score, level } = plateDifficulty(coveragePercent, style);
    plates.push({
      id: colorPlateCount, kind: 'black', width: canvas.width, height: canvas.height,
      color: '#000000', colorName: 'Black Key Plate', maskDataUrl: canvas.toDataURL('image/png'),
      printOrder: totalPlateCount, coveragePercent, difficulty: level, difficultyScore: score,
    });
  }
  const compositeImageUrl = (await composePlateImages(plates))!;
  return { plates, compositeImageUrl };
}

/** Alpha is the ink mask: a pale ink remains ink, and transparent pixels remain paper. */
export async function composePlateImages(plates: Plate[], size?: { width: number; height: number }): Promise<string | null> {
  if (plates.length === 0 && !size) return null;
  const ordered = [...plates].sort((a, b) => Number(a.kind === 'black') - Number(b.kind === 'black'));
  const images = await Promise.all(ordered.map(plate => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = plate.maskDataUrl;
  })));
  const canvas = document.createElement('canvas');
  canvas.width = size?.width ?? images[0].width;
  canvas.height = size?.height ?? images[0].height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const image of images) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export async function recolorPlateMask(maskDataUrl: string, hex: string): Promise<string> {
  const { canvas, ctx, imageData } = await loadImage(maskDataUrl);
  const color: RGB = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)) as RGB;
  for (let i = 0; i < imageData.data.length; i += 4) {
    if (imageData.data[i + 3] > 0) {
      imageData.data[i] = color[0];
      imageData.data[i + 1] = color[1];
      imageData.data[i + 2] = color[2];
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

// ─── Feasibility Analysis ─────────────────────────────────────────────────────

function analyseFeasibility(
  style: PrintStyle,
  plates: Plate[],
  edgeDensity: number,
  avgBrightness: number
): { difficulty: DifficultyLevel; notes: string[] } {
  const notes: string[] = [];
  let score = 0;

  // Edge complexity
  if (edgeDensity > 0.18) {
    notes.push('Dense linework and rich detail will make plate preparation more demanding.');
    score += 30;
  } else if (edgeDensity > 0.10) {
    notes.push('Moderate visual complexity; test a small section before committing to the full plate.');
    score += 15;
  }

  // Dark image = heavy ink coverage
  if (avgBrightness < 95) {
    notes.push('The image is quite dark, so expect heavier ink coverage and possible show-through.');
    score += 18;
  }

  // Many plates = registration challenge
  if (plates.length >= 5) {
    notes.push(`${plates.length} color layers require accurate registration; use crosshair registration marks.`);
    score += 22;
  } else if (plates.length >= 3) {
    score += 10;
  }

  // Small-area plates = isolated islands = tricky
  const smallPlates = plates.filter(p => p.coveragePercent < 8);
  if (smallPlates.length > 0) {
    notes.push(`${smallPlates.map(p => p.colorName).join(', ')} has small coverage with isolated details that may be fragile.`);
    score += 16;
  }

  // Style-specific
  if (style === 'etching') {
    notes.push('Etching time is sensitive; test line weight on a small copper plate first.');
    score += 12;
  } else if (style === 'lithograph') {
    notes.push('Lithography depends on water and grease balance; first attempts benefit from expert guidance.');
    score += 14;
  } else if (style === 'woodblock' && edgeDensity > 0.12) {
    notes.push('Fine lines are safer with the wood grain; slow down when cutting across the grain.');
  }

  if (notes.length === 0) notes.push('Overall feasibility looks good; follow the guide steps in order.');

  const difficulty: DifficultyLevel =
    score >= 70 ? 'Hard' : score >= 45 ? 'Advanced' : score >= 22 ? 'Medium' : 'Easy';

  return { difficulty, notes };
}

// ─── Guide Generation ─────────────────────────────────────────────────────────

export function generateGuide(style: PrintStyle, plates: Plate[]): GuideStep[] {
  const n = plates.length;

  if (style === 'woodblock') {
    return [
      { step: 1, title: 'Prepare the Block', detail: 'Use basswood or pine around 1.5 cm thick, then sand with the grain until smooth.', tip: 'Cutting with the grain is easier; cutting against it gives sharper tension but chips more easily.' },
      { step: 2, title: 'Transfer the Drawing', detail: 'Mirror-print the black plate image, then transfer it with carbon paper or acetone.' },
      { step: 3, title: 'Carve the Key Plate', detail: 'Carve away the white areas: outline with a small knife, clear larger spaces with a gouge, and keep the dark printing surface.', tip: 'Define fine edges first, then clear nearby areas with a wider tool to prevent chipping.' },
      ...(n > 1 ? [{
        step: 4, title: `Carve Color Plates x${n - 1}`,
        detail: `Carve one plate for each of these colors: ${plates.slice(0, -1).map(p => p.colorName).join(', ')}. Leave color areas slightly generous for easier registration.`,
      }] : []),
      { step: n > 1 ? 5 : 4, title: 'Ink and Print', detail: 'Mix ink to a honey-like consistency, roll it evenly, place the paper, press with a baren, and peel steadily.', tip: 'Thin ink bleeds at the edges; thick ink prints patchy.' },
      { step: n > 1 ? 6 : 5, title: `Register Colors x${n}`, detail: `${plates[0].colorName} (lightest) -> ${plates[n - 1].colorName} (darkest). Align each plate to the same corner marks.`, tip: 'Pin the first sheet at two corners, then use those points for every following plate.' },
    ];
  }

  if (style === 'screenprint') {
    return [
      { step: 1, title: 'Prepare the Screens', detail: `Make ${n} screen frames from the separated plates. A 120 mesh polyester screen is a good starting point; keep the mesh evenly tensioned.` },
      { step: 2, title: 'Coat with Emulsion', detail: 'Coat the mesh evenly with photo emulsion, dry it, place the film positive, and expose under UV for 2-4 minutes.', tip: 'Follow the emulsion brand guide and run a wedge exposure test first.' },
      { step: 3, title: 'Wash Out the Image', detail: 'Rinse both sides with warm water until the image area opens, then let the screen dry completely.' },
      { step: 4, title: 'Set Registration', detail: 'Tape the substrate to the table and mark corner guides for accurate alignment.' },
      ...plates.map((p, i) => ({
        step: 5 + i,
        title: `Color ${i + 1} · ${p.colorName}`,
        detail: `Print ${p.colorName} (${p.color}) with acrylic screen ink, holding the squeegee around 45 degrees. Approx. coverage: ${p.coveragePercent}%.`,
        plateRef: p.id,
        tip: i === 0 ? 'Print 2-3 extra sheets on the first pass.' : 'Let the previous color dry fully before printing the next layer.',
      })),
    ];
  }

  if (style === 'etching') {
    return [
      { step: 1, title: 'Prepare the Copper Plate', detail: 'Use a 0.5 mm copper plate, sand from coarse to fine until polished, then degrease with alcohol.' },
      { step: 2, title: 'Apply Ground', detail: 'Warm the plate, apply hard ground, let it cool, and smoke the surface to check even coverage.' },
      { step: 3, title: 'Draw with the Needle', detail: 'Scratch the image lines through the ground; exposed copper becomes the printable line.', tip: 'Keep pressure consistent. Needle angle controls line width.' },
      { step: 4, title: 'Etch', detail: 'Immerse in ferric chloride diluted 1:1, checking every 5 minutes. Total time is usually 10-30 minutes.', tip: 'Short etch creates fine pale lines; longer etch makes darker, heavier lines.' },
      { step: 5, title: 'Clean and Finish', detail: 'Remove the ground with mineral spirits, smooth burrs with an oilstone, and protect the plate with a thin oil layer.' },
      { step: 6, title: 'Ink the Plate', detail: 'Push etching ink into the grooves with a leather dabber, then wipe the surface with tarlatan.', tip: 'Wipe along the line direction so ink stays in the grooves.' },
      { step: 7, title: 'Print Through the Press', detail: 'Dampen printmaking paper, blot surface water, place it over the plate, and run it through the press once.' },
    ];
  }

  return [
    { step: 1, title: 'Grain the Stone', detail: 'Grain limestone with a levigator until the surface is evenly textured; degrease aluminum plates thoroughly.' },
    { step: 2, title: 'Draw with Grease', detail: 'Draw directly with lithographic crayon or tusche; mark density controls ink density.', tip: 'Do not touch non-image areas, because grease contamination affects printing.' },
    { step: 3, title: 'Etch and Fix', detail: 'Apply gum arabic with dilute nitric acid, then rest for 20 minutes so the grease image bonds chemically.' },
    { step: 4, title: 'Wash Out', detail: 'Remove drawing material with mineral spirits and rinse with water, leaving only the invisible ink-receptive image.' },
    ...plates.map((p, i) => ({
      step: 5 + i,
      title: `Plate ${i + 1} · ${p.colorName}`,
      detail: `Dampen the plate, roll ${p.colorName} lithographic ink with a leather roller, and print with even pressure.`,
      plateRef: p.id,
      tip: 'Keep water and grease in balance: too wet rejects ink, too dry lets blank areas print.',
    })),
  ];
}

// ─── Color Extraction (Landing Page) ─────────────────────────────────────────

export interface ExtractedColor {
  hex: string;
  name: string;
  coveragePercent: number;
  isBlack: boolean;
  duotoneUrl: string;
}

function buildDuotoneDataUrl(imageData: ImageData, color: RGB, isBlack: boolean): string {
  const { width: w, height: h, data: s } = imageData;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  const o = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const t = (0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2]) / 255;
    if (isBlack) {
      const v = clamp(t * 230 + 10);
      o[i] = v; o[i + 1] = v; o[i + 2] = v;
    } else {
      o[i]     = clamp(color[0] * t * 1.08 + 6);
      o[i + 1] = clamp(color[1] * t * 1.08 + 4);
      o[i + 2] = clamp(color[2] * t * 1.08 + 2);
    }
    o[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
}

export async function extractDominantColors(src: string): Promise<ExtractedColor[]> {
  const { imageData } = await loadImage(src, 480);
  const pixels = samplePixels(imageData.data, 4);
  const centroids = kMeansClusterLab(pixels, 5);

  const d = imageData.data;
  const counts = new Array(5).fill(0);
  const total = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const p: RGB = [d[i], d[i + 1], d[i + 2]];
    let minD = Infinity, ni = 0;
    for (let j = 0; j < 5; j++) {
      const dist = sqDist(p, centroids[j]);
      if (dist < minD) { minD = dist; ni = j; }
    }
    counts[ni]++;
  }

  const items = centroids.map((c, i) => ({ c: [...c] as RGB, count: counts[i] }));
  items.sort((a, b) => luminance(a.c) - luminance(b.c));

  const origDark = [...items[0].c] as RGB;
  items[0].c = [18, 15, 12];

  return items.map((item, idx) => {
    const displayRgb = idx === 0 ? item.c : boostPrintColor(item.c);
    return {
      hex: toHex(displayRgb),
      name: guessColorName(idx === 0 ? origDark : item.c),
      coveragePercent: Math.round(item.count / total * 100),
      isBlack: idx === 0,
      duotoneUrl: buildDuotoneDataUrl(imageData, displayRgb, idx === 0),
    };
  });
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function processImage(src: string, config: ProcessConfig): Promise<ProcessResult> {
  const { canvas, ctx, imageData } = await loadImage(src);
  const { width: w, height: h } = imageData;
  const originalData = new ImageData(new Uint8ClampedArray(imageData.data), w, h);
  let subjectRegions: SubjectRegions | undefined;
  let subjectStatus: SubjectStatus = 'off';
  if (config.style === 'woodblock' && config.protectPeople) {
    try {
      subjectRegions = config.subjectRegions?.width === w && config.subjectRegions.height === h
        ? { ...config.subjectRegions, labels: new Uint8Array(config.subjectRegions.labels) }
        : await recognizeSubjects(originalData, src);
      subjectStatus = hasPeople(subjectRegions) ? 'protected' : 'none';
    } catch (error) {
      console.error('People recognition failed:', error);
      subjectRegions = { width: w, height: h, labels: new Uint8Array(w * h), source: 'automatic' };
      subjectStatus = 'failed';
    }
  }

  // Pre-compute image stats for feasibility analysis (on original)
  const origGray = toGray(imageData.data);
  const origBlurred = boxBlur(origGray, w, h);
  const edges = sobelEdges(origBlurred, w, h);
  const edgeThreshold = edgePercentileThreshold(edges, 0.88) * 0.3;
  const edgeDensity = computeEdgeDensity(edges, edgeThreshold);
  const avgBrightness = computeAvgBrightness(origGray);

  // Apply style effect
  switch (config.style) {
    case 'woodblock':    renderWoodcut(imageData, config.blackStyle ?? 'block', config.lineWeight); break;
    case 'screenprint':  processScreenprint(imageData, config.colorCount, config.contrast); break;
    case 'etching':      processEtching(imageData, config.lineWeight, config.contrast); break;
    case 'lithograph':   processLithograph(imageData, config.contrast); break;
  }

  ctx.putImageData(imageData, 0, 0);
  const processedImageUrl = canvas.toDataURL('image/png');

  const { plates, compositeImageUrl } = await buildPlates(originalData, config.colorCount, config.style, imageData, subjectStatus === 'protected' ? subjectRegions : undefined);
  const { difficulty: overallDifficulty, notes: feasibilityNotes } =
    analyseFeasibility(config.style, plates, edgeDensity, avgBrightness);

  return { processedImageUrl, compositeImageUrl, plates, overallDifficulty, feasibilityNotes, subjectRegions, subjectStatus };
}
