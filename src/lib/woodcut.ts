/** Browser implementation of the approved shape-and-gouge processing approach.
 * Uses local tone, broad ridges, connected shapes and tapered cuts; no model or server.
 * Browser rasterization and seeded random numbers differ from the Python study.
 */
export type WoodcutStyle = 'block' | 'gouge';
type Field = Float32Array;
type Mask = Uint8Array;

const clip = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));

function box(input: Field, width: number, height: number, radius: number): Field {
  const temp = new Float32Array(input.length), output = new Float32Array(input.length);
  const diameter = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += input[y * width + clip(x, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      temp[y * width + x] = sum / diameter;
      sum += input[y * width + Math.min(width - 1, x + radius + 1)] - input[y * width + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += temp[clip(y, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      output[y * width + x] = sum / diameter;
      sum += temp[Math.min(height - 1, y + radius + 1) * width + x] - temp[Math.max(0, y - radius) * width + x];
    }
  }
  return output;
}

function smooth(input: Field, width: number, height: number, radius: number, epsilon: number): Field {
  const mean = box(input, width, height, radius);
  const meanSquare = box(input.map(value => value * value), width, height, radius);
  const weight = input.map((_, i) => { const variance = Math.max(0, meanSquare[i] - mean[i] ** 2); return variance / (variance + epsilon); });
  const averageWeight = box(weight, width, height, radius);
  const remainder = box(mean.map((value, i) => value * (1 - weight[i])), width, height, radius);
  return input.map((value, i) => averageWeight[i] * value + remainder[i]);
}

function medianChannels(image: ImageData): Field[] {
  const { width, height, data } = image;
  const channels = [new Float32Array(width * height), new Float32Array(width * height), new Float32Array(width * height)];
  const values = new Array<number>(9);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) values[k++] = data[(clip(y + dy, 0, height - 1) * width + clip(x + dx, 0, width - 1)) * 4 + c];
    values.sort((a, b) => a - b);
    channels[c][y * width + x] = values[4] / 255;
  }
  return channels;
}

function morph(input: Mask, width: number, height: number, radius: number, dilate: boolean): Mask {
  const output = new Uint8Array(input.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = dilate ? 0 : 1;
    search: for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const found = input[clip(y + dy, 0, height - 1) * width + clip(x + dx, 0, width - 1)];
      if (dilate ? found > 0 : found === 0) { value = dilate ? 1 : 0; break search; }
    }
    output[y * width + x] = value;
  }
  return output;
}

function close(input: Mask, w: number, h: number, radius: number): Mask { return morph(morph(input, w, h, radius, true), w, h, radius, false); }
function open(input: Mask, w: number, h: number, radius: number): Mask { return morph(morph(input, w, h, radius, false), w, h, radius, true); }

function prune(input: Mask, width: number, height: number, minimum: number): Mask {
  const output = new Uint8Array(input.length), visited = new Uint8Array(input.length), queue = new Int32Array(input.length);
  for (let start = 0; start < input.length; start++) {
    if (!input[start] || visited[start]) continue;
    queue[0] = start; visited[start] = 1;
    let head = 0, tail = 1;
    while (head < tail) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (input[neighbor] && !visited[neighbor]) { visited[neighbor] = 1; queue[tail++] = neighbor; }
      }
    }
    if (tail >= minimum) for (let i = 0; i < tail; i++) output[queue[i]] = 1;
  }
  return output;
}

function gradient(input: Field, width: number, height: number): [Field, Field] {
  const dx = new Float32Array(input.length), dy = new Float32Array(input.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    dx[index] = (input[y * width + Math.min(width - 1, x + 1)] - input[y * width + Math.max(0, x - 1)]) / (x === 0 || x === width - 1 ? 1 : 2);
    dy[index] = (input[Math.min(height - 1, y + 1) * width + x] - input[Math.max(0, y - 1) * width + x]) / (y === 0 || y === height - 1 ? 1 : 2);
  }
  return [dx, dy];
}

function randomGenerator(seed: number): () => number {
  return () => { let value = seed += 0x6D2B79F5; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}

export function renderWoodcut(image: ImageData, style: WoodcutStyle, cutLevel: number): void {
  const {width: w, height: h} = image, size = w * h;
  const unit = Math.max(.45, Math.max(w, h) / 1200);
  const radius = (value: number) => Math.max(1, Math.round(value * unit));
  const average = (field: Field, r: number) => box(field, w, h, radius(r));
  const median = medianChannels(image);
  const detailGray = smooth(median[0].map((r, i) => .299 * r + .587 * median[1][i] + .114 * median[2][i]), w, h, radius(3), .0008);
  const color = median.map(channel => smooth(smooth(channel, w, h, radius(6), .003), w, h, radius(7), .004));
  const gray = color[0].map((r, i) => .299 * r + .587 * color[1][i] + .114 * color[2][i]);
  const saturation = gray.map((_, i) => Math.max(color[0][i], color[1][i], color[2][i]) - Math.min(color[0][i], color[1][i], color[2][i]));
  const localMean = average(gray, 22), mean = average(gray, 10), meanSquare = average(gray.map(value => value * value), 10);
  const texture = gray.map((_, i) => Math.sqrt(Math.max(0, meanSquare[i] - mean[i] ** 2)));
  const tone = gray.map((value, i) => {
    const base = clip(value + .85 * (value - localMean[i]) - .23 * saturation[i]);
    const lift = clip((.035 - texture[i]) / .025) * clip((value - .29) / .22) * clip((.45 - saturation[i]) / .22);
    return clip(base + (1 - base) * lift * .67);
  });
  const d1 = average(detailGray, 1), d2 = average(detailGray, 2), d5 = average(detailGray, 5), d10 = average(detailGray, 10);
  const ridge = d2.map((value, i) => value - d10[i]);
  const colorRidge = new Float32Array(size).fill(Infinity);
  const colorEdge = new Float32Array(size);
  for (const channel of color) {
    const near = average(channel, 1), far = average(channel, 7), [dx, dy] = gradient(channel, w, h);
    for (let i = 0; i < size; i++) { colorRidge[i] = Math.min(colorRidge[i], near[i] - far[i]); colorEdge[i] += dx[i] ** 2 + dy[i] ** 2; }
  }
  const crease = prune(close(Uint8Array.from(gray, (value, i) => Number(((d1[i] - d5[i] < -.011 && ridge[i] < -.015) || colorRidge[i] < -.040) && (value > .64 || texture[i] > .032))), w, h, 1), w, h, Math.max(8, Math.round(35 * unit * unit)));
  const reliefMean = average(detailGray, 9);
  const whiteDetail = prune(Uint8Array.from(gray, (value, i) => Number(detailGray[i] - reliefMean[i] > .045 && value < .36)), w, h, Math.max(4, Math.round(14 * unit * unit)));
  const separation = prune(close(Uint8Array.from(gray, (value, i) => Number(Math.sqrt(colorEdge[i]) > .025 && value > .28 && value < .72 && saturation[i] > .32)), w, h, 1), w, h, Math.max(8, Math.round(35 * unit * unit)));
  const [gx, gy] = gradient(average(gray, 8), w, h);
  const a = average(gx.map(value => value * value), 20), b = average(gx.map((value, i) => value * gy[i]), 20), c = average(gy.map(value => value * value), 20);
  const theta = gray.map((value, i) => {
    const coherence = Math.sqrt((a[i] - c[i]) ** 2 + 4 * b[i] ** 2) / (a[i] + c[i] + 1e-8);
    const angle = coherence < .38 || a[i] + c[i] < .000004 ? value < .32 ? -1.02 : -.22 : .5 * Math.atan2(2 * b[i], a[i] - c[i]) + Math.PI / 2;
    return Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
  });
  let black: Mask = Uint8Array.from(tone, (value, i) => Number(value < (style === 'block' ? .34 : .46) || (ridge[i] < (style === 'block' ? -.046 : -.026) && gray[i] < (style === 'block' ? .87 : .9))));
  black = prune(open(close(black, w, h, radius(style === 'block' ? 2 : 3)), w, h, 1), w, h, Math.max(10, Math.round(40 * unit * unit)));
  const strongCrease = style === 'block' ? prune(crease, w, h, Math.max(18, Math.round(95 * unit * unit))) : null;
  for (let i = 0; i < size; i++) { if (strongCrease?.[i]) black[i] = 1; if (whiteDetail[i]) black[i] = 0; }
  const inset = morph(black, w, h, radius(2), false);
  for (let i = 0; i < size; i++) if (separation[i] && inset[i]) black[i] = 0;

  // Carve tapered, slightly angular paths. A cut stops at a strong tone boundary.
  const random = randomGenerator(style === 'block' ? 20261020 : 20261021);
  const spacing = Math.max(8, (style === 'block' ? 24 : 18) * unit * (1.16 - cutLevel / 300));
  const points: [number, number][] = [];
  for (let y = spacing / 2; y < h; y += spacing) for (let x = spacing / 2; x < w; x += spacing) points.push([x + (random() - .5) * .8 * spacing, y + (random() - .5) * .8 * spacing]);
  for (let i = points.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [points[i], points[j]] = [points[j], points[i]]; }
  const cutCanvas = document.createElement('canvas'); cutCanvas.width = w; cutCanvas.height = h;
  const cutContext = cutCanvas.getContext('2d')!;
  const inkCanvas = document.createElement('canvas'); inkCanvas.width = w; inkCanvas.height = h;
  const inkContext = inkCanvas.getContext('2d')!;
  const occupied = new Uint8Array(size);
  const at = (field: Field, x: number, y: number) => field[clip(Math.floor(y), 0, h - 1) * w + clip(Math.floor(x), 0, w - 1)];
  for (const [x, y] of points) {
    if (x < 2 || x >= w - 2 || y < 2 || y >= h - 2) continue;
    const index = Math.floor(y) * w + Math.floor(x), isInk = black[index] > 0;
    let probability = isInk ? .1 + .48 * clip((gray[index] - .21) / .35) : .8 * clip((.68 - tone[index]) / .27);
    if (style === 'block') { if (!isInk) continue; probability *= .26; }
    if (!isInk && texture[index] < .018) probability *= .08;
    if (!isInk && ridge[index] > .008) probability *= .1;
    if (random() > probability) continue;
    const length = (isInk ? style === 'gouge' ? 40 + random() * 70 : 22 + random() * 33 : 24 + random() * 51) * unit;
    const bladeWidth = (isInk ? style === 'gouge' ? 3 + random() * 5 : 1.8 + random() * 1.7 : 2.5 + random() * 4.5) * unit * (.8 + cutLevel / 200);
    const angle = theta[index] + (random() - .5) * .13;
    const sides: [number, number][][] = [];
    for (const sign of [-1, 1]) {
      let px = x, py = y, vx = Math.cos(angle) * sign, vy = Math.sin(angle) * sign;
      const side: [number, number][] = [[px, py]];
      for (let step = 0; step < Math.max(2, Math.round(length / (10 * unit))); step++) {
        const direction = at(theta, px, py), dot = Math.cos(direction) * vx + Math.sin(direction) * vy;
        vx = .9 * vx + .1 * Math.cos(direction) * (dot < 0 ? -1 : 1);
        vy = .9 * vy + .1 * Math.sin(direction) * (dot < 0 ? -1 : 1);
        const norm = Math.hypot(vx, vy); vx /= norm; vy /= norm;
        const nx = px + vx * 5 * unit, ny = py + vy * 5 * unit;
        if (nx <= 1 || nx >= w - 2 || ny <= 1 || ny >= h - 2 || Math.abs(at(gray, nx, ny) - gray[index]) > .13) break;
        px = nx; py = ny; side.push([px, py]);
      }
      sides.push(side);
    }
    const path = [...sides[0].slice(1).reverse(), ...sides[1]];
    if (path.length < 4 || Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]) < 13 * unit) continue;
    if (path.filter(([px, py]) => occupied[Math.floor(py) * w + Math.floor(px)]).length / path.length > .14) continue;
    const left: [number, number][] = [], right: [number, number][] = [];
    path.forEach(([px, py], i) => {
      const before = path[Math.max(0, i - 1)], after = path[Math.min(path.length - 1, i + 1)];
      const dx = after[0] - before[0], dy = after[1] - before[1], norm = Math.max(1e-5, Math.hypot(dx, dy));
      const t = i / (path.length - 1), profile = Math.pow(Math.sin(Math.PI * t), .7);
      const offset = bladeWidth * .5 * profile * (.78 + random() * .38);
      left.push([px - dy / norm * offset, py + dx / norm * offset]);
      right.push([px + dy / norm * offset, py - dx / norm * offset]);
      occupied[Math.floor(py) * w + Math.floor(px)] = 1;
    });
    const context = isInk ? cutContext : inkContext;
    const polygon = [...left, ...right.reverse()]; context.fillStyle = '#000'; context.beginPath(); context.moveTo(...polygon[0]); for (const point of polygon.slice(1)) context.lineTo(...point); context.closePath(); context.fill();
  }
  const cuts = cutContext.getImageData(0, 0, w, h).data, accents = inkContext.getImageData(0, 0, w, h).data;
  for (let i = 0; i < size; i++) { if (cuts[i * 4 + 3] > 127 && inset[i]) black[i] = 0; if (accents[i * 4 + 3] > 127 && !black[i]) black[i] = 1; if (style === 'gouge' && crease[i] && ridge[i] < -.017) black[i] = 1; }
  black = prune(black, w, h, Math.max(8, Math.round(25 * unit * unit)));
  for (let i = 0; i < size; i++) { const value = black[i] ? 0 : 255; image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = value; image.data[i * 4 + 3] = 255; }
}
