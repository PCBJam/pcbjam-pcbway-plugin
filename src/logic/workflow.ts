import type { BoardSummary, BundleSummary, ExportStep } from '../contracts';
import { buildBomCsv, buildPositionsCsv, type FabComponentsDoc } from './fab';

/** The slice of the PCBJam host API this plugin uses; tests pass a fake. */
export interface ExportApi {
  run(kind: 'gerbers' | 'drill' | 'ipc356' | 'fab-components'): Promise<{ exportId: string; files: { name: string; size: number }[] }>;
  readJson(exportId: string, name: string): Promise<unknown>;
  bundle(proposal: { parts: { exportId: string; rename?: Record<string, string> }[]; extraFiles?: { name: string; text: string }[]; zipName: string }): Promise<{ bundleId: string } & BundleSummary>;
  saveBundle(proposal: { bundleId: string }): Promise<{ status: 'download-requested' | 'cancelled' }>;
}

/** File names PCBWay's own KiCad plugin uses for the files it adds to the ZIP. */
export const PCBWAY_FILES = { netlist: 'PCBWay_netlist.ipc', bom: 'PCBWay_bom.csv', positions: 'PCBWay_positions.csv' } as const;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPoint = (value: unknown) => !!value && typeof value === 'object' && isNumber((value as { x: unknown }).x) && isNumber((value as { y: unknown }).y);

/** The export is PCBJam's, but check its shape before building CSVs from it. */
export function parseFabDoc(value: unknown): FabComponentsDoc {
  const doc = value as FabComponentsDoc;
  const board = doc?.board;
  if (!board || !isNumber(board.widthMm) || !isNumber(board.heightMm) || !isNumber(board.copperLayers) || !isPoint(board.auxOriginMm) || !Array.isArray(doc.footprints))
    throw new Error('The component export has an unexpected format.');
  for (const fp of doc.footprints) {
    if (!fp || typeof fp.ref !== 'string' || typeof fp.fpid !== 'string' || (fp.side !== 'top' && fp.side !== 'bottom') || !isPoint(fp.posMm) || !isNumber(fp.rotationDeg)
      || typeof fp.fields !== 'object' || fp.fields === null)
      throw new Error('The component export has an unexpected format.');
  }
  return doc;
}

/** `<board>.kicad_pcb.zip`, like PCBWay's plugin, limited to the characters PCBJam accepts in file names. */
export function zipNameFor(fileName: string) {
  const base = (fileName.split('/').pop() || 'board.kicad_pcb').replace(/[^a-zA-Z0-9 _.-]/g, '_').replace(/^[^a-zA-Z0-9]+/, '');
  return (base || 'board').slice(0, 86) + '.zip';
}

/** One run of the PCBWay workflow. Each step is a separate UI command so the panel can show progress. */
export class PcbwaySession {
  private fab?: { exportId: string; doc: FabComponentsDoc };
  private exports = new Map<ExportStep, string>();
  private bundleId?: string;
  private fileName = 'board.kicad_pcb';

  constructor(private readonly api: ExportApi) {}

  async inspect(fileName: string): Promise<BoardSummary> {
    this.exports.clear();
    this.bundleId = undefined;
    this.fileName = fileName;
    const run = await this.api.run('fab-components');
    const json = run.files.find(file => file.name.endsWith('.json'));
    if (!json) throw new Error('The component export produced no data.');
    const doc = parseFabDoc(await this.api.readJson(run.exportId, json.name));
    this.fab = { exportId: run.exportId, doc };
    const placed = doc.footprints.filter(fp => !fp.excludeFromPos);
    return {
      fileName,
      widthMm: doc.board.widthMm,
      heightMm: doc.board.heightMm,
      copperLayers: doc.board.copperLayers,
      parts: doc.footprints.length,
      smd: placed.filter(fp => fp.smd).length,
      tht: placed.filter(fp => !fp.smd).length,
    };
  }

  async export(kind: ExportStep) {
    if (!this.fab) throw new Error('Read the board first.');
    const run = await this.api.run(kind);
    if (!run.files.length) throw new Error(`The ${kind} export produced no files.`);
    this.exports.set(kind, run.exportId);
    return { files: run.files.length };
  }

  async pack(): Promise<BundleSummary> {
    if (!this.fab) throw new Error('Read the board first.');
    const missing = (['gerbers', 'drill', 'ipc356'] as const).filter(kind => !this.exports.has(kind));
    if (missing.length) throw new Error('Missing exports: ' + missing.join(', '));
    const bundle = await this.api.bundle({
      parts: [
        { exportId: this.exports.get('gerbers')! },
        { exportId: this.exports.get('drill')! },
        { exportId: this.exports.get('ipc356')!, rename: { 'netlist.ipc': PCBWAY_FILES.netlist } },
      ],
      extraFiles: [
        { name: PCBWAY_FILES.bom, text: buildBomCsv(this.fab.doc) },
        { name: PCBWAY_FILES.positions, text: buildPositionsCsv(this.fab.doc) },
      ],
      zipName: zipNameFor(this.fileName),
    });
    this.bundleId = bundle.bundleId;
    return { name: bundle.name, size: bundle.size, files: bundle.files };
  }

  async download() {
    if (!this.bundleId) throw new Error('Build the ZIP first.');
    return this.api.saveBundle({ bundleId: this.bundleId });
  }
}
