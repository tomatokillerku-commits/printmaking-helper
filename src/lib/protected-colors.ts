import type { SubjectRegions } from './subjects';
type RGB = [number, number, number];
type Lab = [number, number, number];
export type InkRole = 'skin' | 'clothing' | 'background';
export interface ColorSeparation {
  colors: RGB[];
  roles: InkRole[];
  assignments: Int16Array;
}

/** Partition ink budgets by subject first. A large background cannot consume skin inks. */
export function separateNaturalColors(
  image: ImageData, count: number, regions: SubjectRegions | undefined,
  cluster: (pixels: RGB[], count: number) => RGB[], toLab: (rgb: RGB) => Lab,
): ColorSeparation {
  const { data, width, height } = image;
  const size = width * height;
  const labels = regions?.labels;
  const groups = new Int8Array(size).fill(-1);
  const samples: RGB[][] = [[], [], []];
  const groupPixels = [0, 0, 0];
  const filtered = new Uint8ClampedArray(data);
  const values = new Array<number>(9);
  // Small median filter removes color flecks without mixing skin into adjacent foliage.
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const pixel = y * width + x;
    for (let c = 0; c < 3; c++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const neighbor = (y + dy) * width + x + dx;
        if (!labels || labels[neighbor] === labels[pixel]) values[n++] = data[neighbor * 4 + c];
      }
      const sorted = values.slice(0, n).sort((a, b) => a - b);
      filtered[pixel * 4 + c] = sorted[Math.floor(n / 2)];
    }
  }
  for (let index = 0; index < size; index++) {
    if (data[index * 4 + 3] === 0) continue;
    const region = labels?.[index] ?? 0;
    if (region === 3) continue; // Hair is expressed by the independent black key and paper.
    const group = region === 1 ? 1 : region === 2 ? 2 : 0;
    const rgb: RGB = [filtered[index * 4], filtered[index * 4 + 1], filtered[index * 4 + 2]];
    if (group === 0 && Math.min(...rgb) > 216 && Math.max(...rgb) - Math.min(...rgb) < 32) continue;
    groups[index] = group;
    groupPixels[group]++;
    if (index % 3 === 0 || !samples[group].length) samples[group].push(rgb);
  }
  // A tiny detected sliver is too unreliable to reserve an entire printing plate.
  const minimumRegion = regions?.source === 'manual' ? 0 : Math.max(12, size * .001);
  const skinPresent = groupPixels[1] > minimumRegion;
  const clothesPresent = groupPixels[2] > minimumRegion;
  for (const group of [1, 2]) if ((group === 1 && !skinPresent) || (group === 2 && !clothesPresent)) {
    for (let i = 0; i < size; i++) if (groups[i] === group) groups[i] = 0;
    samples[0].push(...samples[group]); groupPixels[0] += groupPixels[group]; samples[group] = []; groupPixels[group] = 0;
  }
  const allocations = [0, 0, 0];
  const priority = [skinPresent ? 1 : -1, clothesPresent ? 2 : -1, groupPixels[0] ? 0 : -1].filter(group => group >= 0);
  let used = 0;
  for (const group of priority) if (used < count) { allocations[group]++; used++; }
  const extras = skinPresent || clothesPresent ? [0, 1, 2, 0, 0, 1, 2] : [0];
  let next = 0;
  while (used < count && priority.length) {
    const group = extras[next++ % extras.length];
    if (!groupPixels[group]) continue;
    allocations[group]++; used++;
  }
  const entries: { color: RGB; group: number; role: InkRole }[] = [];
  const roleNames: InkRole[] = ['background', 'skin', 'clothing'];
  for (let group = 0; group < 3; group++) if (allocations[group]) {
    const input = samples[group].length ? samples[group] : [[255, 255, 255] as RGB];
    for (const color of cluster(input, allocations[group])) entries.push({ color, group, role: roleNames[group] });
  }
  while (entries.length < count) entries.push({ color: [255, 255, 255], group: -1, role: 'background' });
  entries.sort((a, b) => (.299 * b.color[0] + .587 * b.color[1] + .114 * b.color[2]) - (.299 * a.color[0] + .587 * a.color[1] + .114 * a.color[2]));
  const paletteLab = entries.map(entry => toLab(entry.color));
  const assignments = new Int16Array(size).fill(-1);
  for (let index = 0; index < size; index++) {
    const group = groups[index];
    if (group < 0 || allocations[group] === 0) continue;
    const lab = toLab([filtered[index * 4], filtered[index * 4 + 1], filtered[index * 4 + 2]]);
    let choice = -1, distance = Infinity;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].group !== group) continue;
      const candidate = (lab[0] - paletteLab[i][0]) ** 2 + (lab[1] - paletteLab[i][1]) ** 2 + (lab[2] - paletteLab[i][2]) ** 2;
      if (candidate < distance) { choice = i; distance = candidate; }
    }
    assignments[index] = choice;
  }
  return { colors: entries.map(entry => entry.color), roles: entries.map(entry => entry.role), assignments };
}
