import type { ImageSegmenter } from '../../public/vendor/mediapipe/vision';

/** 0 background/objects, 1 face and body skin, 2 clothing, 3 hair. */
export interface SubjectRegions {
  width: number;
  height: number;
  labels: Uint8Array;
  source: 'automatic' | 'manual';
}
export type SubjectStatus = 'protected' | 'none' | 'failed' | 'off';
let segmenterPromise: Promise<ImageSegmenter> | undefined;
let lastResult: { key: string; regions: SubjectRegions } | undefined;

async function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const base = `${import.meta.env.BASE_URL}vendor/mediapipe`;
      const vision = await import(/* @vite-ignore */ `${base}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${base}/wasm`, false);
      return vision.ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: `${base}/selfie_multiclass_256x256.tflite`, delegate: 'CPU' },
        runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false,
      });
    })();
    segmenterPromise.catch(() => { segmenterPromise = undefined; });
  }
  return segmenterPromise;
}

export function hasPeople(regions: SubjectRegions): boolean {
  let skin = 0, clothing = 0;
  for (const label of regions.labels) { if (label === 1) skin++; else if (label === 2) clothing++; }
  return skin + clothing > (regions.source === 'manual' ? 0 : regions.labels.length * .008);
}

export async function recognizeSubjects(image: ImageData, key: string): Promise<SubjectRegions> {
  if (lastResult?.key === key && lastResult.regions.width === image.width && lastResult.regions.height === image.height) return { ...lastResult.regions, labels: new Uint8Array(lastResult.regions.labels) };
  const segmenter = await getSegmenter();
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  const result = segmenter.segment(canvas);
  try {
    const mask = result.categoryMask;
    if (!mask) throw new Error('The subject model returned no category mask.');
    const raw = mask.getAsUint8Array();
    const labels = new Uint8Array(image.width * image.height);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const index = y * image.width + x;
      const value = raw[Math.min(mask.height - 1, Math.floor(y * mask.height / image.height)) * mask.width + Math.min(mask.width - 1, Math.floor(x * mask.width / image.width))];
      let region = value === 2 || value === 3 ? 1 : value === 4 ? 2 : value === 1 ? 3 : 0;
      // A green leaf crossing a face remains an object, rather than becoming skin ink.
      const r = image.data[index * 4], g = image.data[index * 4 + 1], b = image.data[index * 4 + 2];
      if (region === 1 && g > r * 1.12 && g > b * 1.12 && g - Math.min(r, b) > 35) region = 0;
      labels[index] = region;
    }
    const regions: SubjectRegions = { width: image.width, height: image.height, labels, source: 'automatic' };
    lastResult = { key, regions: { ...regions, labels: new Uint8Array(labels) } };
    return regions;
  } finally { result.close(); }
}
