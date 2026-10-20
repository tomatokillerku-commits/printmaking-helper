import { useState, useCallback, useRef, useEffect } from 'react';
import {
  processImage, generateGuide, composePlateImages, recolorPlateMask,
  type PrintStyle, type ProcessConfig, type Plate, type GuideStep, type DifficultyLevel,
} from './lib/printmaking';
import rollerToolUrl from './imports/roller-tool.png';
import squeegeeToolUrl from './imports/squeegee-tool.png';
import Workspace from './Workspace';
import type { SubjectRegions, SubjectStatus } from './lib/subjects';

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  brown:   '#583202',
  sage:    '#B5CD74',
  blue:    '#6280B7',
  brick:   '#AA453B',
  ink:     '#120A01',
  surface: '#1E1108',
  panel:   '#2A1A0A',
  border:  '#3D2610',
  paper:   '#EDE0C8',
  dim:     '#8A7558',
};

// ─── Constants ────────────────────────────────────────────────────────────────
const STYLES: { id: PrintStyle; zh: string; en: string; enFull: string; desc: string }[] = [
  { id: 'woodblock',   zh: 'Woodblock Relief', en: 'Woodblock',   enFull: 'WOODBLOCK RELIEF',  desc: 'Carved marks and bold contrast' },
  { id: 'screenprint', zh: 'Screenprint',      en: 'Screenprint', enFull: 'SCREENPRINT',       desc: 'Flat color layers and crisp registration' },
];

const TECHNIQUE_DETAILS: Record<string, {
  summary: string;
  features: string[];
  principle: string;
  process: string[];
  imageLabels: string[];
}> = {
  woodblock: {
    summary: 'A relief process carved into wood, inked with a roller, and printed by hand or press. It carries strong graphic contrast and a visible sense of the carved surface.',
    features: ['Carved texture with physical energy', 'Bold contrast and strong plate character', 'Simple tools, clear process'],
    principle: 'A woodblock image is made by the surface that remains. The carved-away areas do not take ink; the uncut areas become lines, shapes, and color layers, so the final print keeps the feeling of both carving and printing.',
    process: ['Transfer the drawing and plan the key plate', 'Carve away white and light areas', 'Roll ink, proof, and refine edges', 'Print color layers from light to dark'],
    imageLabels: ['Woodblock artwork', 'Carving detail', 'Registration sample'],
  },
  screenprint: {
    summary: 'A stencil process that pushes ink through mesh onto paper. It is known for saturated color, flat graphic shapes, and clean multi-layer prints.',
    features: ['Saturated flat color', 'Flexible multi-color registration', 'Strong poster-like graphic style'],
    principle: 'Screenprint relies on open mesh areas that let ink pass through. Each color is a clean ink layer, making it ideal for bold shapes, poster compositions, and repeatable editions.',
    process: ['Separate artwork into color films', 'Expose and wash out the screen', 'Pull ink evenly with the squeegee', 'Let each layer dry before the next pass'],
    imageLabels: ['Screenprint artwork', 'Mesh detail', 'Color registration sample'],
  },
};

const MATERIALS: Record<PrintStyle, string[]> = {
  woodblock:   ['Basswood block, 1.5 cm', 'Carving tools: flat, round, V-gouge', 'Printmaking ink', 'Rubber brayer', 'Baren or hand press', 'Printmaking paper'],
  screenprint: ['Screen frame, 120 mesh', 'Photo emulsion', 'Acrylic screen ink', 'Firm squeegee', 'UV exposure lamp', 'Printmaking paper or fabric'],
  etching:     [],
  lithograph:  [],
};

type DifficultyMode = 'easy' | 'medium' | 'hard';
const DIFFICULTY_MODES: { id: DifficultyMode; zh: string; lineWeight: number }[] = [
  { id: 'easy',   zh: 'Low', lineWeight: 25 },
  { id: 'medium', zh: 'Medium', lineWeight: 55 },
  { id: 'hard',   zh: 'High', lineWeight: 85 },
];

// ─── Custom Cursors ───────────────────────────────────────────────────────────
const mkCursor = (svg: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;

const WOODBLOCK_CURSOR = mkCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect x="4" y="12" width="24" height="8" rx="3" fill="${C.brown}" stroke="${C.sage}" stroke-width="1.5"/>
    <rect x="1" y="10" width="4" height="12" rx="2" fill="${C.brick}"/>
    <rect x="27" y="10" width="4" height="12" rx="2" fill="${C.brick}"/>
    <line x1="10" y1="14" x2="10" y2="18" stroke="${C.sage}" stroke-width="1" opacity="0.8"/>
    <line x1="16" y1="14" x2="16" y2="18" stroke="${C.sage}" stroke-width="1" opacity="0.8"/>
    <line x1="22" y1="14" x2="22" y2="18" stroke="${C.sage}" stroke-width="1" opacity="0.8"/>
  </svg>`
);

const SCREENPRINT_CURSOR = mkCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect x="2" y="2" width="28" height="28" rx="2" fill="${C.ink}" stroke="${C.blue}" stroke-width="2"/>
    <line x1="2" y1="10" x2="30" y2="10" stroke="${C.blue}" stroke-width="0.8" opacity="0.5"/>
    <line x1="2" y1="18" x2="30" y2="18" stroke="${C.blue}" stroke-width="0.8" opacity="0.5"/>
    <line x1="2" y1="26" x2="30" y2="26" stroke="${C.blue}" stroke-width="0.8" opacity="0.5"/>
    <line x1="10" y1="2" x2="10" y2="30" stroke="${C.blue}" stroke-width="0.8" opacity="0.5"/>
    <line x1="18" y1="2" x2="18" y2="30" stroke="${C.blue}" stroke-width="0.8" opacity="0.5"/>
    <line x1="26" y1="2" x2="26" y2="30" stroke="${C.blue}" stroke-width="0.8" opacity="0.5"/>
  </svg>`
);

// ─── Icons ────────────────────────────────────────────────────────────────────
function WoodblockIcon({ size = 28, color = C.paper }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke={color} strokeLinecap="round">
      <line x1="3" y1="7"  x2="25" y2="7"  strokeWidth="3" />
      <line x1="3" y1="13" x2="18" y2="13" strokeWidth="1.5" />
      <line x1="3" y1="19" x2="25" y2="19" strokeWidth="2.5" />
      <line x1="3" y1="25" x2="14" y2="25" strokeWidth="1.5" />
    </svg>
  );
}

function ScreenprintIcon({ size = 28, color = C.paper }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill={color}>
      <rect x="2"  y="2"  width="10" height="10" rx="1.5" />
      <rect x="16" y="2"  width="10" height="10" rx="1.5" opacity="0.4" />
      <rect x="2"  y="16" width="10" height="10" rx="1.5" opacity="0.25" />
      <rect x="16" y="16" width="10" height="10" rx="1.5" opacity="0.65" />
    </svg>
  );
}

function UploadIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 22V10" />
      <path d="M12 16l6-6 6 6" />
      <path d="M6 28h24" />
    </svg>
  );
}

// ─── Image Placeholder ────────────────────────────────────────────────────────
function ImgPlaceholder({
  width, height, label, style: extraStyle = {},
}: {
  width: number | string; height: number | string; label?: string; style?: React.CSSProperties;
}) {
  return (
    <div style={{
      width, height, flexShrink: 0,
      backgroundColor: C.surface,
      border: `1px solid ${C.border}`,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 8,
      overflow: 'hidden', position: 'relative',
      ...extraStyle,
    }}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={C.border} strokeWidth="1.5">
        <rect x="2" y="2" width="16" height="16" rx="2" />
        <circle cx="7" cy="7" r="1.5" />
        <path d="M18 13l-4-4L6 18" />
      </svg>
      {label && (
        <p style={{ fontFamily: 'JetBrains Mono', fontSize: 9, color: C.border, letterSpacing: '0.1em' }}>
          {label}
        </p>
      )}
    </div>
  );
}

// ─── Landing Page ─────────────────────────────────────────────────────────────
const PALETTE_STRIPE = [C.brick, C.brown, C.blue, C.sage];

function ColorStripe({ flip = false }: { flip?: boolean }) {
  const colors = flip ? [...PALETTE_STRIPE].reverse() : PALETTE_STRIPE;
  return (
    <div style={{ display: 'flex', height: 4, width: '100%', flexShrink: 0 }}>
      {colors.map((c, i) => (
        <div key={i} style={{ flex: 1, backgroundColor: c }} />
      ))}
    </div>
  );
}

function LandingPage({ onEnter }: { onEnter: (style: PrintStyle) => void }) {
  const [hovered, setHovered] = useState<PrintStyle | null>(null);
  const activeStyle = hovered ? STYLES.find(s => s.id === hovered) : null;
  const activeDetails = hovered ? TECHNIQUE_DETAILS[hovered] : null;
  const activeAccent = hovered === 'screenprint' ? '#E44322' : C.brown;

  const handlePointerMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).closest('[data-hover-zone="true"]')) {
      setHovered(null);
    }
  };

  return (
    <div
      className="landing-shell h-full overflow-hidden"
      onMouseMove={handlePointerMove}
      style={{
        backgroundColor: '#FFFFFF',
        color: '#17100A',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      <div
        className="landing-tool landing-tool-roller"
        data-hover-zone="true"
        onMouseEnter={() => setHovered('woodblock')}
        style={{
        position: 'absolute',
        left: hovered === 'woodblock' ? '11vw' : '-8.5vw',
        top: hovered === 'woodblock' ? '48%' : '51%',
        width: hovered === 'woodblock' ? 'min(39vw, 500px)' : 'min(36vw, 420px)',
        height: hovered === 'woodblock' ? '88vh' : '104vh',
        overflow: 'hidden',
        transform: 'translateY(-50%)',
        transition: 'left 0.46s ease, top 0.46s ease, width 0.46s ease, height 0.46s ease, opacity 0.28s ease',
        opacity: hovered === 'screenprint' ? 0.06 : 1,
        pointerEvents: 'auto',
        zIndex: hovered === 'woodblock' ? 3 : 1,
      }}>
        <img
          src={rollerToolUrl}
          alt=""
          style={{
            height: '100%',
            width: 'auto',
            objectFit: 'contain',
            transform: hovered === 'woodblock' ? 'translateX(-7%)' : 'translateX(-17%)',
            filter: 'drop-shadow(0 22px 42px rgba(0,0,0,0.16))',
            transition: 'transform 0.46s ease',
          }}
        />
      </div>

      <div
        className="landing-tool landing-tool-squeegee"
        data-hover-zone="true"
        onMouseEnter={() => setHovered('screenprint')}
        style={{
        position: 'absolute',
        right: hovered === 'screenprint' ? '50%' : '-19vw',
        top: hovered === 'screenprint' ? '52%' : '52%',
        width: hovered === 'screenprint' ? 'min(64vw, 920px)' : 'min(48vw, 650px)',
        height: hovered === 'screenprint' ? '43vh' : '46vh',
        overflow: 'hidden',
        transform: hovered === 'screenprint' ? 'translate(50%, -50%)' : 'translateY(-50%)',
        transition: 'right 0.46s ease, width 0.46s ease, height 0.46s ease, opacity 0.28s ease',
        opacity: hovered === 'woodblock' ? 0.06 : 1,
        pointerEvents: 'auto',
        zIndex: hovered === 'screenprint' ? 3 : 1,
      }}>
        <img
          src={squeegeeToolUrl}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transform: hovered === 'screenprint' ? 'translateX(0)' : 'translateX(18%)',
            filter: 'drop-shadow(0 24px 44px rgba(0,0,0,0.12))',
            transition: 'transform 0.46s ease',
          }}
        />
      </div>

      {activeStyle && activeDetails && (
        <div
          className={`landing-active-copy landing-active-copy-${activeStyle.id}`}
          data-hover-zone="true"
          onMouseEnter={() => setHovered(activeStyle.id)}
          style={{
            position: 'absolute',
            left: activeStyle.id === 'woodblock' ? '47vw' : '50%',
            top: activeStyle.id === 'woodblock' ? '22%' : '8%',
            width: activeStyle.id === 'woodblock' ? 'min(40vw, 520px)' : 'min(62vw, 820px)',
            height: activeStyle.id === 'screenprint' ? '86vh' : 'auto',
            transform: activeStyle.id === 'screenprint' ? 'translateX(-50%)' : 'none',
            zIndex: 4,
            textAlign: activeStyle.id === 'woodblock' ? 'left' : 'center',
            transition: 'opacity 0.28s ease, transform 0.28s ease',
          }}
        >
          <p className="font-mono" style={{ color: activeAccent, fontSize: 10, letterSpacing: '0.18em', marginBottom: 12 }}>
            {activeStyle.enFull}
          </p>
          <h2 style={{ color: '#000000', fontSize: 64, lineHeight: 1, fontWeight: 800, letterSpacing: 0, marginBottom: 16 }}>
            {activeStyle.zh}
          </h2>
          <p style={{ color: '#27211B', fontSize: 14, lineHeight: 1.9, maxWidth: 650, margin: activeStyle.id === 'screenprint' ? '0 auto 22px' : '0 0 22px' }}>
            {activeDetails.principle}
          </p>
          <div style={{
            display: 'grid',
            gridTemplateColumns: activeStyle.id === 'screenprint' ? 'repeat(4, minmax(0, 1fr))' : '1fr',
            gap: activeStyle.id === 'screenprint' ? 18 : 10,
            marginTop: activeStyle.id === 'screenprint' ? 0 : 0,
            position: activeStyle.id === 'screenprint' ? 'absolute' : 'static',
            left: activeStyle.id === 'screenprint' ? '50%' : undefined,
            bottom: activeStyle.id === 'screenprint' ? 86 : undefined,
            width: activeStyle.id === 'screenprint' ? 'min(70vw, 900px)' : undefined,
            transform: activeStyle.id === 'screenprint' ? 'translateX(-50%)' : undefined,
          }}>
            {activeDetails.process.map((item, i) => (
              <div key={item} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 0,
                justifyContent: activeStyle.id === 'screenprint' ? 'center' : 'flex-start',
                color: '#17100A',
                fontSize: activeStyle.id === 'screenprint' ? 10 : 12,
                lineHeight: activeStyle.id === 'screenprint' ? 1.45 : 1.5,
                minHeight: activeStyle.id === 'screenprint' ? 30 : undefined,
              }}>
                <span>{item}</span>
                {activeStyle.id === 'screenprint' && i < activeDetails.process.length - 1 && (
                  <span style={{ color: activeAccent, marginLeft: 12, opacity: 0.45 }}>/</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="landing-main-column" style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 40px',
        position: 'relative',
        zIndex: 5,
        pointerEvents: 'none',
        opacity: hovered ? 0 : 1,
        transition: 'opacity 0.24s ease',
        animation: hovered ? 'none' : 'fade-up 0.8s ease forwards',
      }}>
        <p className="font-mono tracking-[0.22em]" style={{ fontSize: 10, color: '#8D7A61', marginBottom: 18, textAlign: 'center' }}>
          PRINTMAKING STUDIO
          <span style={{ color: C.brick, margin: '0 10px' }}>·</span>
          IMAGE TO PRINT PLATES
        </p>

        <h1 style={{
          fontSize: 'clamp(4rem, 10vw, 8.6rem)',
          fontWeight: 800,
          letterSpacing: 0,
          lineHeight: 0.88,
          textAlign: 'center',
          color: '#17100A',
          opacity: hovered ? 0 : 1,
          transform: hovered ? 'translateY(-12px)' : 'translateY(0)',
          transition: 'opacity 0.28s ease, transform 0.28s ease',
        }}>
          PRINT
          <br />
          MAKING
        </h1>

        <p style={{
          fontSize: 13,
          color: '#7C6A52',
          lineHeight: 1.8,
          maxWidth: 430,
          textAlign: 'center',
          marginTop: 22,
          opacity: hovered ? 0 : 1,
          transform: hovered ? 'translateY(-8px)' : 'translateY(0)',
          transition: 'opacity 0.2s ease, transform 0.2s ease',
        }}>
          Upload an image, generate separated color plates, and follow a practical printing guide.
        </p>
      </div>

      <button
        type="button"
        className="landing-entry-label landing-entry-woodblock"
        data-hover-zone="true"
        onMouseEnter={() => setHovered('woodblock')}
        onClick={() => onEnter('woodblock')}
        style={{
          position: 'absolute',
          left: hovered === 'woodblock' ? '3.6vw' : '11.8vw',
          top: hovered === 'woodblock' ? '80vh' : '38vh',
          zIndex: 6,
          border: 0,
          background: 'transparent',
          padding: 0,
          color: '#000000',
          fontSize: hovered === 'woodblock' ? 22 : 26,
          lineHeight: 1.15,
          fontWeight: 800,
          textAlign: 'left',
          cursor: 'pointer',
          transition: 'left 0.42s ease, top 0.42s ease, font-size 0.28s ease, opacity 0.2s ease',
          opacity: hovered === 'screenprint' ? 0 : 1,
        }}
      >
        WOODBLOCK<br />RELIEF
      </button>

      <button
        type="button"
        className="landing-entry-label landing-entry-screenprint"
        data-hover-zone="true"
        onMouseEnter={() => setHovered('screenprint')}
        onClick={() => onEnter('screenprint')}
        style={{
          position: 'absolute',
          right: hovered === 'screenprint' ? '50%' : '14vw',
          top: hovered === 'screenprint' ? '89vh' : '78vh',
          zIndex: 6,
          border: 0,
          background: 'transparent',
          padding: 0,
          color: '#000000',
          fontSize: hovered === 'screenprint' ? 26 : 28,
          lineHeight: 1.1,
          fontWeight: 800,
          textAlign: 'left',
          cursor: 'pointer',
          transform: hovered === 'screenprint' ? 'translateX(50%)' : 'none',
          transition: 'right 0.42s ease, top 0.42s ease, transform 0.42s ease, font-size 0.28s ease, opacity 0.2s ease',
          opacity: hovered === 'woodblock' ? 0 : 1,
        }}
      >
        SCREENPRINT
      </button>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
type AppView = 'landing' | 'workspace';

function normalizeHexColor(value: string): string | null {
  const clean = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return '#' + clean.split('').map(c => c + c).join('').toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return '#' + clean.toUpperCase();
  return null;
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plate';
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }

  let c = 0xFFFFFFFF;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function writeU16(out: number[], value: number) {
  out.push(value & 0xFF, (value >>> 8) & 0xFF);
}

function writeU32(out: number[], value: number) {
  out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
}

function createZipBlob(files: { name: string; bytes: Uint8Array }[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  files.forEach(file => {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const local: number[] = [];
    writeU32(local, 0x04034B50);
    writeU16(local, 20);
    writeU16(local, 0x0800);
    writeU16(local, 0);
    writeU16(local, dosTime);
    writeU16(local, dosDate);
    writeU32(local, crc);
    writeU32(local, file.bytes.length);
    writeU32(local, file.bytes.length);
    writeU16(local, name.length);
    writeU16(local, 0);
    local.push(...name);
    chunks.push(new Uint8Array(local), file.bytes);

    const centralEntry: number[] = [];
    writeU32(centralEntry, 0x02014B50);
    writeU16(centralEntry, 20);
    writeU16(centralEntry, 20);
    writeU16(centralEntry, 0x0800);
    writeU16(centralEntry, 0);
    writeU16(centralEntry, dosTime);
    writeU16(centralEntry, dosDate);
    writeU32(centralEntry, crc);
    writeU32(centralEntry, file.bytes.length);
    writeU32(centralEntry, file.bytes.length);
    writeU16(centralEntry, name.length);
    writeU16(centralEntry, 0);
    writeU16(centralEntry, 0);
    writeU16(centralEntry, 0);
    writeU16(centralEntry, 0);
    writeU32(centralEntry, 0);
    writeU32(centralEntry, offset);
    centralEntry.push(...name);
    central.push(new Uint8Array(centralEntry));

    offset += local.length + file.bytes.length;
  });

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end: number[] = [];
  writeU32(end, 0x06054B50);
  writeU16(end, 0);
  writeU16(end, 0);
  writeU16(end, files.length);
  writeU16(end, files.length);
  writeU32(end, centralSize);
  writeU32(end, offset);
  writeU16(end, 0);

  const blobParts = [...chunks, ...central, new Uint8Array(end)].map(chunk =>
    chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
  );
  return new Blob(blobParts, { type: 'application/zip' });
}

export default function App() {
  const [appView, setAppView]     = useState<AppView>('landing');
  const [style, setStyle]         = useState<PrintStyle>('woodblock');
  const [colorCount, setColorCount]         = useState(5);
  const [difficultyMode, setDifficultyMode] = useState<DifficultyMode>('medium');
  const [blackStyle, setBlackStyle] = useState<'block' | 'gouge'>('block');
  const [protectPeople, setProtectPeople] = useState(true);
  const [subjectRegions, setSubjectRegions] = useState<SubjectRegions>();
  const [subjectStatus, setSubjectStatus] = useState<SubjectStatus>('off');
  const manualRegionsRef = useRef<SubjectRegions | undefined>(undefined);

  const [sourceImage,      setSourceImage]      = useState<string | null>(null);
  const [processedImage,   setProcessedImage]   = useState<string | null>(null);
  const [compositeImageUrl, setCompositeImageUrl] = useState<string | null>(null);
  const [processing,       setProcessing]       = useState(false);
  const [primaryView,   setPrimaryView]   = useState<'processed' | 'original'>('processed');

  const [plates,          setPlates]          = useState<Plate[]>([]);
  const [selectedPlateId, setSelectedPlateId] = useState<number | null>(null);
  const [guide,           setGuide]           = useState<GuideStep[]>([]);
  const [guideOpen,       setGuideOpen]       = useState(false);
  const [overallDiff,     setOverallDiff]     = useState<DifficultyLevel | null>(null);
  const [feasNotes,       setFeasNotes]       = useState<string[]>([]);
  const [colorDraft,      setColorDraft]      = useState('#000000');
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);

  const [visiblePlateIds, setVisiblePlateIds] = useState<Set<number>>(new Set());
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const dragFromIdRef = useRef<number | null>(null);
  // Refs to keep latest config accessible in callbacks
  const styleRef         = useRef(style);
  const colorCountRef    = useRef(colorCount);
  const difficultyRef    = useRef(difficultyMode);
  const blackStyleRef = useRef(blackStyle);
  const protectPeopleRef = useRef(protectPeople);
  useEffect(() => { styleRef.current = style; },         [style]);
  useEffect(() => { colorCountRef.current = colorCount; },[colorCount]);
  useEffect(() => { difficultyRef.current = difficultyMode; }, [difficultyMode]);
  useEffect(() => { blackStyleRef.current = blackStyle; }, [blackStyle]);
  useEffect(() => { protectPeopleRef.current = protectPeople; }, [protectPeople]);

  useEffect(() => {
    const plate = plates.find(p => p.id === selectedPlateId);
    if (plate) setColorDraft(plate.color);
  }, [plates, selectedPlateId]);

  // Rebuild composite whenever visible layers change
  useEffect(() => {
    const visiblePlates = plates.filter(p => visiblePlateIds.has(p.id) && p.maskDataUrl);
    if (plates.length === 0) { setCompositeImageUrl(null); return; }

    let cancelled = false;

    composePlateImages(visiblePlates, plates[0])
      .then(url => { if (!cancelled) setCompositeImageUrl(url); })
      .catch(console.error);

    return () => { cancelled = true; };
  }, [plates, visiblePlateIds]);

  useEffect(() => {
    if (plates.length > 0) setGuide(generateGuide(style, plates));
  }, [plates, style]);

  const handleTogglePlateVisible = useCallback((id: number) => {
    setVisiblePlateIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleLayerDragStart = useCallback((id: number) => {
    dragFromIdRef.current = id;
  }, []);

  const handleLayerDragOver = useCallback((e: React.DragEvent, id: number) => {
    e.preventDefault();
    setDragOverId(id);
  }, []);

  const handleLayerDrop = useCallback((targetId: number) => {
    const sourceId = dragFromIdRef.current;
    if (sourceId === null || sourceId === targetId) { setDragOverId(null); return; }
    setPlates(prev => {
      if (prev.find(p => p.id === sourceId)?.kind === 'black' || prev.find(p => p.id === targetId)?.kind === 'black') return prev;
      const fromIdx = prev.findIndex(p => p.id === sourceId);
      const toIdx   = prev.findIndex(p => p.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next.map((p, i) => ({ ...p, printOrder: i + 1 }));
    });
    dragFromIdRef.current = null;
    setDragOverId(null);
  }, []);

  const handleLayerDragEnd = useCallback(() => {
    dragFromIdRef.current = null;
    setDragOverId(null);
  }, []);

  const handlePlateColorChange = useCallback(async (plate: Plate, value: string) => {
    if (plate.kind === 'black') return;
    setColorDraft(value);
    const hex = normalizeHexColor(value);
    if (!hex) return;

    try {
      const maskDataUrl = await recolorPlateMask(plate.maskDataUrl, hex);
      setPlates(prev => prev.map(p => p.id === plate.id
        ? { ...p, color: hex, colorName: `Custom ${hex}`, maskDataUrl }
        : p
      ));
    } catch (err) {
      console.error('Color replacement failed:', err);
    }
  }, []);

  const handleSavePlateImages = useCallback(() => {
    const exportPlates = plates.filter(p => p.maskDataUrl);
    if (exportPlates.length === 0) return;

    const files = exportPlates.map(p => ({
      name: p.kind === 'black' ? `${String(p.printOrder).padStart(2, '0')}-black-key-plate.png` : `${String(p.printOrder).padStart(2, '0')}-${sanitizeFilename(p.colorName)}-${p.color.replace('#', '')}.png`,
      bytes: dataUrlToBytes(p.maskDataUrl),
    }));
    const blob = createZipBlob(files);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${style}-separated-plates.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [plates, style]);

  const handleSaveSinglePlate = useCallback((plate: Plate) => {
    const link = document.createElement('a');
    link.href = plate.maskDataUrl;
    link.download = plate.kind === 'black' ? 'black-key-plate.png' : `${String(plate.printOrder).padStart(2, '0')}-${sanitizeFilename(plate.colorName)}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, []);

  const resetWorkspace = useCallback(() => {
    setProcessedImage(null);
    setCompositeImageUrl(null);
    setPlates([]);
    setGuide([]);
    setSelectedPlateId(null);
    setGuideOpen(false);
    setOverallDiff(null);
    setFeasNotes([]);
    setPrimaryView('processed');
    setVisiblePlateIds(new Set());
    setProcessingError(null);
    setSettingsDirty(false);
  }, []);

  const enterWorkspace = useCallback((s: PrintStyle) => {
    setStyle(s);
    setSourceImage(null);
    manualRegionsRef.current = undefined;
    setSubjectRegions(undefined);
    setSubjectStatus('off');
    resetWorkspace();
    setAppView('workspace');
  }, [resetWorkspace]);

  const goBack = useCallback(() => {
    setAppView('landing');
    setSourceImage(null);
    manualRegionsRef.current = undefined;
    setSubjectRegions(undefined);
    setSubjectStatus('off');
    resetWorkspace();
  }, [resetWorkspace]);

  // ── Auto-process on upload
  const handleFile = useCallback(async (file: File) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setProcessingError('Please choose a JPG, PNG, or WebP image.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setProcessingError('This image is larger than 10 MB. Please choose a smaller file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target?.result as string;
      setSourceImage(dataUrl);
      manualRegionsRef.current = undefined;
      setSubjectRegions(undefined);
      setSubjectStatus('off');
      resetWorkspace();
      setProcessing(true);

      const dm = difficultyRef.current;
      const lw = DIFFICULTY_MODES.find(d => d.id === dm)?.lineWeight ?? 55;
      const config: ProcessConfig = {
        style:       styleRef.current,
        colorCount:  colorCountRef.current,
        blackStyle: blackStyleRef.current,
        protectPeople: protectPeopleRef.current,
        contrast:    65,
        lineWeight:  lw,
      };

      try {
        const result = await processImage(dataUrl, config);
        const compositeUrl = result.compositeImageUrl || await composePlateImages(result.plates);
        setVisiblePlateIds(new Set(result.plates.map(p => p.id)));
        setProcessedImage(compositeUrl || result.processedImageUrl);
        setCompositeImageUrl(compositeUrl);
        setPrimaryView('processed');
        setPlates(result.plates);
        setSubjectRegions(result.subjectRegions);
        setSubjectStatus(result.subjectStatus ?? 'off');
        setGuide(generateGuide(styleRef.current, result.plates));
        setOverallDiff(result.overallDifficulty);
        setFeasNotes(result.feasibilityNotes);
      } catch (err) {
        console.error('Processing failed:', err);
        setProcessingError('This image could not be processed. Please try another JPG, PNG, or WebP.');
      } finally {
        setProcessing(false);
      }
    };
    reader.readAsDataURL(file);
  }, [resetWorkspace]);

  // ── Re-process (when user changes settings after upload)
  const handleReprocess = useCallback(async () => {
    if (!sourceImage || processing) return;
    setProcessing(true);
    resetWorkspace();

    const dm = difficultyRef.current;
    const lw = DIFFICULTY_MODES.find(d => d.id === dm)?.lineWeight ?? 55;
    const config: ProcessConfig = {
      style:      styleRef.current,
      colorCount: colorCountRef.current,
      blackStyle: blackStyleRef.current,
      protectPeople: protectPeopleRef.current,
      subjectRegions: manualRegionsRef.current,
      contrast:   65,
      lineWeight: lw,
    };
    try {
      const result = await processImage(sourceImage, config);
      const compositeUrl = result.compositeImageUrl || await composePlateImages(result.plates);
      setVisiblePlateIds(new Set(result.plates.map(p => p.id)));
      setProcessedImage(compositeUrl || result.processedImageUrl);
      setCompositeImageUrl(compositeUrl);
      setPrimaryView('processed');
      setPlates(result.plates);
      setSubjectRegions(result.subjectRegions);
      setSubjectStatus(result.subjectStatus ?? 'off');
      setGuide(generateGuide(styleRef.current, result.plates));
      setOverallDiff(result.overallDifficulty);
      setFeasNotes(result.feasibilityNotes);
    } catch (err) {
      console.error('Reprocess failed:', err);
      setProcessingError('The preview could not be updated. Please try again.');
    } finally {
      setProcessing(false);
    }
  }, [sourceImage, processing, resetWorkspace]);

  // ── Landing
  if (appView === 'landing') return <LandingPage onEnter={enterWorkspace} />;

  const currentStyle = STYLES.find(s => s.id === style)!;
  const selectedPlate = plates.find(p => p.id === selectedPlateId) ?? null;
  return (
    <Workspace
      style={style} title={currentStyle.enFull} description={currentStyle.desc}
      sourceImage={sourceImage} effectImage={compositeImageUrl || processedImage}
      processing={processing} processingError={processingError}
      totalPlates={colorCount} cutLevel={difficultyMode} settingsDirty={settingsDirty}
      blackStyle={blackStyle} onBlackStyleChange={value => { setBlackStyle(value); setSettingsDirty(true); }}
      protectPeople={protectPeople} subjectRegions={subjectRegions} subjectStatus={subjectStatus}
      onProtectPeopleChange={value => { setProtectPeople(value); setSettingsDirty(true); }}
      onApplyRegions={regions => { manualRegionsRef.current = regions; void handleReprocess(); }}
      onResetRegions={() => { manualRegionsRef.current = undefined; void handleReprocess(); }}
      onTotalPlatesChange={value => { setColorCount(value); setSettingsDirty(true); }}
      onCutLevelChange={value => { setDifficultyMode(value); setSettingsDirty(true); }}
      onUpdate={handleReprocess} onFile={handleFile} onBack={goBack}
      plates={plates} selectedPlate={selectedPlate} visiblePlateIds={visiblePlateIds}
      primaryView={primaryView} onPrimaryViewChange={view => { setSelectedPlateId(null); setPrimaryView(view); }}
      onSelectPlate={id => { setSelectedPlateId(id); setPrimaryView('processed'); }}
      onTogglePlateVisible={handleTogglePlateVisible}
      colorDraft={colorDraft} onPlateColorChange={handlePlateColorChange}
      onSavePlate={handleSaveSinglePlate} onSaveAll={handleSavePlateImages}
      onLayerDragStart={handleLayerDragStart} onLayerDragOver={handleLayerDragOver}
      onLayerDrop={handleLayerDrop} onLayerDragEnd={handleLayerDragEnd} dragOverId={dragOverId}
      materials={MATERIALS[style]} guide={guide} guideOpen={guideOpen}
      onGuideToggle={() => setGuideOpen(value => !value)}
    />
  );
}
