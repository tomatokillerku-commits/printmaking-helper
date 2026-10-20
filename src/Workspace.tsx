import { useRef, useState, type CSSProperties, type DragEvent } from 'react';
import type { GuideStep, Plate, PrintStyle } from './lib/printmaking';
import type { SubjectRegions, SubjectStatus } from './lib/subjects';
import RegionEditor from './RegionEditor';
import rollerToolUrl from './imports/roller-tool.png';
import squeegeeToolUrl from './imports/squeegee-tool.png';

type CutLevel = 'easy' | 'medium' | 'hard';
interface Props {
  style: PrintStyle;
  title: string;
  description: string;
  sourceImage: string | null;
  effectImage: string | null;
  processing: boolean;
  processingError: string | null;
  totalPlates: number;
  cutLevel: CutLevel;
  blackStyle: 'block' | 'gouge';
  onBlackStyleChange: (value: 'block' | 'gouge') => void;
  settingsDirty: boolean;
  protectPeople: boolean;
  subjectRegions?: SubjectRegions;
  subjectStatus: SubjectStatus;
  onProtectPeopleChange: (value: boolean) => void;
  onApplyRegions: (regions: SubjectRegions) => void;
  onResetRegions: () => void;
  onTotalPlatesChange: (value: number) => void;
  onCutLevelChange: (value: CutLevel) => void;
  onUpdate: () => void;
  onFile: (file: File) => void;
  onBack: () => void;
  plates: Plate[];
  selectedPlate: Plate | null;
  visiblePlateIds: Set<number>;
  primaryView: 'processed' | 'original';
  onPrimaryViewChange: (view: 'processed' | 'original') => void;
  onSelectPlate: (id: number | null) => void;
  onTogglePlateVisible: (id: number) => void;
  colorDraft: string;
  onPlateColorChange: (plate: Plate, value: string) => void;
  onSavePlate: (plate: Plate) => void;
  onSaveAll: () => void;
  onLayerDragStart: (id: number) => void;
  onLayerDragOver: (event: DragEvent, id: number) => void;
  onLayerDrop: (id: number) => void;
  onLayerDragEnd: () => void;
  dragOverId: number | null;
  materials: string[];
  guide: GuideStep[];
  guideOpen: boolean;
  onGuideToggle: () => void;
}

function Arrow({ direction = 'right' }: { direction?: 'right' | 'up' | 'down' | 'left' }) {
  const rotation = { right: 0, down: 90, left: 180, up: -90 }[direction];
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ transform: `rotate(${rotation}deg)` }}><path d="M4 12h15M13 5l7 7-7 7" /></svg>;
}

export default function Workspace(props: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const [editingRegions, setEditingRegions] = useState(false);
  const blackPlate = props.plates.find(plate => plate.kind === 'black');
  const colorPlates = props.plates.filter(plate => plate.kind === 'color');
  const hasSkinAndClothing = colorPlates.some(plate => plate.role === 'skin') && colorPlates.some(plate => plate.role === 'clothing');
  // With a background ink, paper only shows through the gaps; the old caption then lied.
  const hasBackgroundInk = colorPlates.some(plate => plate.role === 'background');
  const selected = props.selectedPlate;
  const currentImage = selected?.maskDataUrl ?? (props.primaryView === 'original' ? props.sourceImage : props.effectImage || props.sourceImage);
  const activeCount = props.plates.filter(plate => props.visiblePlateIds.has(plate.id)).length;
  const chooseFile = () => fileInput.current?.click();
  // Serigraphy has no key plate: the darkest ink is simply the last flat colour printed.
  const darkName = props.style === 'screenprint' ? 'Darkest ink' : 'Black key plate';
  const darkHint = props.style === 'screenprint' ? 'Flat ink on transparency. Printed last.' : 'Carved marks on transparency. Printed last.';
  const displayName = selected?.kind === 'black' ? darkName : selected ? selected.colorName : props.primaryView === 'original' ? 'Original photograph' : 'Composite proof';
  const draftValid = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(props.colorDraft);
  const rootStyle = { '--studio-accent': props.style === 'woodblock' ? '#AA453B' : '#E44322' } as CSSProperties;

  return (
    <main className="studio-workspace" style={rootStyle}>
      <input id="studio-image-file" ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden
        onChange={event => { const file = event.target.files?.[0]; if (file) props.onFile(file); event.target.value = ''; }} />

      <header className="studio-nav">
        <button className="studio-wordmark" onClick={props.onBack} aria-label="Printmaking Studio home">PRINT<br />MAKING<span>.</span></button>
        <p className="studio-eyebrow studio-nav-caption">PRINTMAKING STUDIO <span>·</span> IMAGE TO PRINT PLATES</p>
        <button className="studio-text-button" onClick={props.onBack}><Arrow direction="left" /> Back home</button>
      </header>

      <section className="studio-hero" aria-labelledby="studio-title">
        <div className="studio-hero-copy">
          <p className="studio-eyebrow"><span className="studio-dot" /> THE PRINT WORKSHOP / 02</p>
          <h1 id="studio-title">{props.style === 'woodblock' ? <>WOODBLOCK<br />RELIEF</> : <>SCREEN<br />PRINT</>}</h1>
          <p className="studio-intro">{props.description}.<br />Make a proof. Separate the inks. Print one plate at a time.</p>
        </div>
        <img className={`studio-hero-tool studio-hero-tool--${props.style}`} src={props.style === 'woodblock' ? rollerToolUrl : squeegeeToolUrl} alt="" aria-hidden="true" />
        <div className="studio-hero-note"><span className="studio-eyebrow">FROM PHOTO<br />TO PRINT</span><Arrow direction="down" /></div>
      </section>

      <div className="studio-workbench">
        <section className="studio-proof" aria-labelledby="proof-title">
          <div className="studio-section-head">
            <h2 id="proof-title" className="studio-eyebrow">01 / YOUR PRINT</h2>
            {props.sourceImage && <button className="studio-text-button" onClick={chooseFile} disabled={props.processing}>Replace image <Arrow /></button>}
          </div>
          {props.sourceImage && (
            <div className="studio-proof-toolbar" aria-label="Preview views">
              <div className="studio-view-switch">
                <button aria-pressed={!selected && props.primaryView === 'processed'} onClick={() => props.onPrimaryViewChange('processed')}>Composite</button>
                <button aria-pressed={!selected && props.primaryView === 'original'} onClick={() => props.onPrimaryViewChange('original')}>Original</button>
                <button disabled={!blackPlate} aria-pressed={selected?.kind === 'black'} onClick={() => blackPlate && props.onSelectPlate(blackPlate.id)}>{darkName}</button>
              </div>
              {props.plates.length > 0 && <span className="studio-proof-count">{activeCount} / {props.plates.length} plates visible</span>}
            </div>
          )}
          <div className={`studio-proof-stage ${dropping ? 'is-dropping' : ''} ${selected ? 'studio-transparency' : ''}`}
            onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropping(true); } }}
            onDragLeave={() => setDropping(false)}
            onDrop={event => { event.preventDefault(); setDropping(false); if (!props.processing && event.dataTransfer.files[0]) props.onFile(event.dataTransfer.files[0]); }}>
            {!props.sourceImage ? (
              <button className="studio-upload" onClick={chooseFile} aria-label="Upload an image" disabled={props.processing}>
                <span className="studio-upload-icon"><Arrow direction="up" /></span>
                <span className="studio-upload-title">A photograph.<br />A new impression.</span>
                <span className="studio-upload-description">Drop your image here, or choose a file.</span>
                <span className="studio-upload-action">Choose an image <Arrow /></span>
                <span className="studio-eyebrow studio-file-types">JPG / PNG / WEBP · UP TO 10 MB</span>
              </button>
            ) : currentImage ? (
              <img className="studio-proof-image" src={currentImage} alt={displayName} />
            ) : null}
            {props.processing && <div className="studio-processing" role="status"><span className="studio-spinner" /><p>{props.style === 'woodblock' && props.protectPeople ? 'Recognizing regions & preparing plates…' : 'Preparing your printing plates…'}</p></div>}
          </div>
          {props.sourceImage && !props.processing && <div className="studio-proof-caption"><span>{displayName}</span>{selected ? <button className="studio-text-button" onClick={() => props.onPrimaryViewChange('processed')}>Back to composite <Arrow /></button> : <span>{hasBackgroundInk ? 'Background inks are printed; paper shows through the gaps.' : 'Paper is the background, not a printing plate.'}</span>}</div>}
          {props.processingError && <p className="studio-error" role="alert">{props.processingError}</p>}

          {selected && <section className="studio-ink-editor" aria-label="Selected plate settings">
            <div><p className="studio-eyebrow">{selected.kind === 'black' ? darkName.toUpperCase() : 'CHANGE THIS INK'}</p><p>{selected.kind === 'black' ? darkHint : 'Change the ink while keeping this plate’s shape.'}</p></div>
            <div className="studio-ink-editor-controls">
              {selected.kind === 'color' && <><input type="color" value={/^#[0-9a-f]{6}$/i.test(props.colorDraft) ? props.colorDraft : selected.color} onChange={event => props.onPlateColorChange(selected, event.target.value)} aria-label="Choose plate color" /><input className="studio-hex" value={props.colorDraft} aria-label="Plate color hex value" aria-invalid={!draftValid} spellCheck={false} onChange={event => props.onPlateColorChange(selected, event.target.value)} /></>}
              <button className="studio-button studio-button--outline" onClick={() => props.onSavePlate(selected)}>Save {selected.kind === 'black' ? `${darkName} PNG` : 'plate PNG'} <Arrow direction="down" /></button>
            </div>
          </section>}
        </section>

        <aside className="studio-settings" aria-labelledby="settings-title">
          <h2 id="settings-title" className="studio-eyebrow">02 / MAKE IT YOURS</h2>
          <div className="studio-setting-block">
            <label className="studio-label" htmlFor="total-plate-count">Total printing plates <span>Black included</span></label>
            <select id="total-plate-count" value={props.totalPlates} disabled={props.processing} onChange={event => props.onTotalPlatesChange(Number(event.target.value))}>
              {[3, 4, 5, 6, 7, 8, 9].map(count => <option key={count} value={count}>{count} plates</option>)}
            </select>
            <p className="studio-setting-note">{props.totalPlates - 1} color inks + 1 black key plate</p>
          </div>
          {props.style === 'woodblock' && <div className="studio-setting-block"><label className="studio-label" htmlFor="black-plate-style">Black plate style</label><select id="black-plate-style" value={props.blackStyle} disabled={props.processing} onChange={event => props.onBlackStyleChange(event.target.value as 'block' | 'gouge')}><option value="block">A · Block shapes</option><option value="gouge">B · Bold gouges</option></select></div>}
          {props.style === 'woodblock' && <fieldset className="studio-setting-block">
            <legend className="studio-label">Cut mark level</legend>
            <div className="studio-segments">{([['easy', 'Low'], ['medium', 'Medium'], ['hard', 'High']] as const).map(([value, label]) => <button key={value} disabled={props.processing} aria-pressed={props.cutLevel === value} onClick={() => props.onCutLevelChange(value)}>{label}</button>)}</div>
          </fieldset>}
          {props.style === 'woodblock' && <div className="studio-setting-block studio-person-setting">
            <label className="studio-person-toggle"><input type="checkbox" checked={props.protectPeople} disabled={props.processing} onChange={event => props.onProtectPeopleChange(event.target.checked)} /><span>Protect people’s colors</span></label>
            <p className="studio-setting-note">Recognize skin and clothing before choosing inks. Images stay on this device.</p>
            {props.sourceImage && !props.processing && !props.settingsDirty && <p className={`studio-recognition-status ${props.subjectStatus === 'failed' ? 'is-warning' : ''}`} role="status">{props.subjectStatus === 'protected' ? props.subjectRegions?.source === 'manual' ? 'Your corrected regions are applied.' : 'People detected · important colors have reserved inks.' : props.subjectStatus === 'none' ? 'No clear person detected. Refine regions if needed.' : props.subjectStatus === 'failed' ? 'Automatic recognition failed. Retry or paint regions manually.' : 'People protection is off.'}</p>}
            {props.protectPeople && props.subjectRegions && !props.processing && <button className="studio-text-button" onClick={() => setEditingRegions(true)}>Refine person regions <Arrow /></button>}
            {props.protectPeople && props.subjectStatus === 'protected' && hasSkinAndClothing && props.totalPlates === 3 && <p className="studio-setting-note">At 3 plates, skin and clothing use the two color inks. Use 4+ plates to add background color.</p>}
          </div>}
          {props.sourceImage && <button className="studio-button" onClick={props.onUpdate} disabled={props.processing}>{props.processing ? 'Preparing plates…' : props.settingsDirty ? 'Apply changes' : 'Regenerate proof'}<Arrow /></button>}
          <div className="studio-setting-divider" />
          <div className="studio-layer-heading"><h2 className="studio-eyebrow">INK SEPARATIONS</h2>{props.plates.length > 0 && <span>{props.style === 'screenprint' ? `${props.plates.length} INKS` : `${colorPlates.length} COLOR + 1 BLACK`}</span>}</div>
          {props.plates.length > 0 && props.plates.length !== props.totalPlates && <p className="studio-setting-note is-plate-shortfall">{props.totalPlates} plates requested · {props.plates.length} have printable area. An ink with almost no area was dropped instead of printing a blank plate; the paper carries that area.</p>}
          {props.plates.length === 0 ? <div className="studio-empty-layers"><span className="studio-empty-swatch" /><span className="studio-empty-swatch" /><span className="studio-empty-swatch is-black" /><p>{props.sourceImage && !props.processing ? 'Nothing separable in this image: it has too little tonal range to divide into inks. Try a photograph with more contrast.' : 'Your color plates and a separate black key plate will appear here.'}</p></div> : (
            <div className="studio-layers">{[...props.plates].reverse().map(plate => {
              const visible = props.visiblePlateIds.has(plate.id);
              const isSelected = selected?.id === plate.id;
              return <div key={plate.id} className={`studio-layer ${isSelected ? 'is-selected' : ''} ${props.dragOverId === plate.id && plate.kind === 'color' ? 'is-drag-over' : ''}`} data-plate-kind={plate.kind} onDragOver={event => { if (plate.kind === 'color') props.onLayerDragOver(event, plate.id); }} onDrop={event => { event.stopPropagation(); props.onLayerDrop(plate.id); }}>
                <button className="studio-layer-thumb studio-transparency" aria-label={`View ${plate.kind === 'black' ? darkName : plate.colorName}`} aria-pressed={isSelected} onClick={() => props.onSelectPlate(isSelected ? null : plate.id)}><img src={plate.maskDataUrl} alt="" /></button>
                <div className="studio-layer-info"><button className="studio-layer-name" onClick={() => props.onSelectPlate(isSelected ? null : plate.id)}>{plate.kind === 'black' ? darkName : plate.colorName.replace(' Plate', '')}</button><span className="studio-layer-meta"><i style={{ backgroundColor: plate.color }} />{plate.kind === 'black' ? 'PRINT LAST' : plate.color.toUpperCase()} · {plate.coveragePercent}%</span></div>
                <div className="studio-layer-actions"><label className="studio-visibility"><input type="checkbox" checked={visible} aria-label={`Show ${plate.kind === 'black' ? darkName : plate.colorName}`} onChange={() => props.onTogglePlateVisible(plate.id)} /><span className="sr-only">Show plate</span></label><button className="studio-icon-button" aria-label={`Save ${plate.kind === 'black' ? darkName : plate.colorName} PNG`} onClick={() => props.onSavePlate(plate)}><Arrow direction="down" /></button>{plate.kind === 'color' && <button className="studio-drag-handle" draggable aria-label={`Drag to reorder ${plate.colorName}`} onDragStart={() => props.onLayerDragStart(plate.id)} onDragEnd={props.onLayerDragEnd}>⠿</button>}</div>
              </div>;
            })}</div>
          )}
          {props.plates.length > 0 && <><button className="studio-button studio-button--outline studio-export-all" onClick={props.onSaveAll}>Download all plates <Arrow direction="down" /></button><p className="studio-setting-note">Separate transparent PNGs, including the black plate.</p></>}
          <details className="studio-materials"><summary>Materials for your print <span>+</span></summary><ul>{props.materials.map(material => <li key={material}>{material}</li>)}</ul></details>
        </aside>
      </div>

      {props.guide.length > 0 && <section className="studio-guide">
        <button className="studio-guide-heading" aria-expanded={props.guideOpen} onClick={props.onGuideToggle}><span><span className="studio-eyebrow">03 / FROM SCREEN TO PAPER</span><span className="studio-guide-title">The printing guide.</span></span><span className="studio-guide-toggle">{props.guideOpen ? 'Close guide' : 'Open guide'} <Arrow direction={props.guideOpen ? 'up' : 'down'} /></span></button>
        {props.guideOpen && <div className="studio-guide-steps">{props.guide.map(step => <article key={step.step}><p className="studio-eyebrow">STEP {String(step.step).padStart(2, '0')}</p><h3>{step.title}</h3><p>{step.detail}</p>{step.tip && <p className="studio-guide-tip">{step.tip}</p>}</article>)}</div>}
      </section>}
      <footer className="studio-footer"><span className="studio-eyebrow">PRINTMAKING STUDIO</span><span>Every impression starts with a mark.</span></footer>
      {editingRegions && props.sourceImage && props.subjectRegions && <RegionEditor image={props.sourceImage} regions={props.subjectRegions} onCancel={() => setEditingRegions(false)} onApply={regions => { setEditingRegions(false); props.onApplyRegions(regions); }} onReset={() => { setEditingRegions(false); props.onResetRegions(); }} />}
    </main>
  );
}
