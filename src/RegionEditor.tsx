import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { SubjectRegions } from './lib/subjects';

interface Props {
  image: string;
  regions: SubjectRegions;
  onApply: (regions: SubjectRegions) => void;
  onCancel: () => void;
  onReset: () => void;
}
const REGION_NAMES = ['Background / objects', 'Skin', 'Clothing', 'Hair'];
const OVERLAY = [[80, 80, 80], [240, 143, 79], [65, 132, 224], [156, 103, 186]];

export default function RegionEditor({ image, regions, onApply, onCancel, onReset }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const original = useRef<ImageData | null>(null);
  const labels = useRef(new Uint8Array(regions.labels));
  const history = useRef<Uint8Array[]>([]);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const [brush, setBrush] = useState(1);
  const [size, setSize] = useState(30);
  const [undoCount, setUndoCount] = useState(0);

  const redraw = () => {
    if (!original.current || !canvas.current) return;
    const pixels = new Uint8ClampedArray(original.current.data);
    for (let i = 0; i < labels.current.length; i++) {
      const role = labels.current[i];
      const alpha = role === 0 ? .15 : .52;
      for (let c = 0; c < 3; c++) pixels[i * 4 + c] = pixels[i * 4 + c] * (1 - alpha) + OVERLAY[role][c] * alpha;
    }
    canvas.current.getContext('2d')!.putImageData(new ImageData(pixels, regions.width, regions.height), 0, 0);
  };

  useEffect(() => {
    dialog.current?.showModal();
    let cancelled = false;
    const source = new Image();
    source.onload = () => {
      if (cancelled || !canvas.current) return;
      const context = canvas.current.getContext('2d')!;
      context.drawImage(source, 0, 0, regions.width, regions.height);
      original.current = context.getImageData(0, 0, regions.width, regions.height);
      redraw();
    };
    source.src = image;
    return () => { cancelled = true; };
  }, [image, regions]);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * regions.width / rect.width, y: (event.clientY - rect.top) * regions.height / rect.height };
  };
  const paint = (end: { x: number; y: number }) => {
    const start = lastPoint.current ?? end;
    const radius = size * regions.width / 800 / 2;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius / 2)));
    for (let step = 0; step <= steps; step++) {
      const x = start.x + (end.x - start.x) * step / steps;
      const y = start.y + (end.y - start.y) * step / steps;
      for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(regions.height - 1, Math.ceil(y + radius)); py++) {
        for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(regions.width - 1, Math.ceil(x + radius)); px++) {
          if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) labels.current[py * regions.width + px] = brush;
        }
      }
    }
    lastPoint.current = end;
    redraw();
  };
  const finishStroke = () => { lastPoint.current = null; };

  return <dialog ref={dialog} className="studio-region-dialog" aria-labelledby="region-editor-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <div className="studio-region-head"><div><p className="studio-eyebrow">REFINE THE RECOGNITION</p><h2 id="region-editor-title">Give every region its place.</h2></div><button className="studio-text-button" onClick={onCancel} aria-label="Close region editor">Close ×</button></div>
    <p className="studio-region-help">Orange = skin · Blue = clothing · Purple = hair. Paint over mistakes. Use Background / objects to remove a person label from leaves or other objects.</p>
    <div className="studio-region-tools"><div className="studio-region-brushes">{REGION_NAMES.map((name, value) => <button key={name} className="studio-region-brush" aria-pressed={brush === value} onClick={() => setBrush(value)}><i style={{ background: `rgb(${OVERLAY[value].join(',')})` }} />{name}</button>)}</div><label className="studio-region-size">Brush size<input type="range" min="6" max="100" value={size} onChange={event => setSize(Number(event.target.value))} /></label><button className="studio-text-button" disabled={!undoCount} onClick={() => { const previous = history.current.pop(); if (previous) labels.current = new Uint8Array(previous); setUndoCount(history.current.length); redraw(); }}>Undo</button></div>
    <canvas ref={canvas} width={regions.width} height={regions.height} className="studio-region-canvas" aria-label="Paint person regions" onPointerDown={event => {
      if (!original.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      history.current.push(new Uint8Array(labels.current));
      if (history.current.length > 15) history.current.shift();
      setUndoCount(history.current.length); paint(point(event));
    }} onPointerMove={event => { if (lastPoint.current) paint(point(event)); }} onPointerUp={finishStroke} onPointerCancel={finishStroke} onLostPointerCapture={finishStroke} />
    <div className="studio-region-footer"><button className="studio-text-button" onClick={onReset}>Reset to automatic</button><div><button className="studio-button studio-button--outline" onClick={onCancel}>Cancel</button><button className="studio-button" onClick={() => onApply({ ...regions, labels: new Uint8Array(labels.current), source: 'manual' })}>Apply regions & regenerate</button></div></div>
  </dialog>;
}
