import type { BoardSummary, BundleSummary, ExportStep } from '../contracts';
import { buildBomCsv, buildPositionsCsv, type FabComponentsDoc } from './fab';

/** The slice of the PCBJam host API this plugin uses; tests pass a fake. */
type ExportKind = 'gerbers' | 'drill' | 'ipc356' | 'fab-components';
type ExportRun = { exportId: string; files: { name: string; size: number }[] };

export interface ExportApi {
  run(kind: ExportKind): Promise<ExportRun>;
  /** Several exports in one KiCad run, in the order asked (hosts with `exports.runMany`). */
  runMany(kinds: ExportKind[]): Promise<ExportRun[]>;
  readJson(exportId: string, name: string): Promise<unknown>;
  bundle(proposal: { parts: { exportId: string; rename?: Record<string, string> }[]; extraFiles?: { name: string; text: string }[]; zipName: string }): Promise<{ bundleId: string } & BundleSummary>;
  saveBundle(proposal: { bundleId: string }): Promise<{ status: 'download-requested' | 'cancelled' }>;
  upload(endpointId: string, request: { path: string; bundleId: string; fields: Record<string, string> }): Promise<{ status: number; body: unknown }>;
  openExternal(url: string): Promise<{ status: 'opened' | 'cancelled' }>;
}

/** PCBWay's KiCad upload, as used by PCBWay's own KiCad plugin (plugins/thread.py). */
export const PCBWAY_UPLOAD_PATH = '/Common/KiCadUpFile/';

/**
 * PCBWay's answer must name a quote page on PCBWay's own site before we offer
 * to open it: https, no credentials or port, and the endpoint's site.
 */
export function quoteUrlFrom(body: unknown, origin: string): string {
  const redirect = (body as { redirect?: unknown } | null)?.redirect;
  if (typeof redirect !== 'string') throw new Error('PCBWay answered without a quote link.');
  // Plugin logic runs in QuickJS, which has no URL parser. The host part may
  // not contain '@' or ':', so no credentials and no port get through.
  const host = /^https:\/\/([A-Za-z0-9.-]+)(?:[/?#][^\s]*)?$/.exec(redirect)?.[1]?.toLowerCase();
  if (!host) throw new Error('PCBWay answered with a link outside PCBWay.');
  const site = (/^https:\/\/([a-z0-9.-]+)$/.exec(origin)?.[1] ?? '').replace(/^www\./, '');
  if (!site || !(host === site || host.endsWith('.' + site)))
    throw new Error('PCBWay answered with a link outside PCBWay.');
  return redirect;
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

/** Waits before asking a busy export service again (`EXPORT_UNAVAILABLE`: its pool is full). */
export const BUSY_RETRY_MS = [1000, 2000, 4000];

/**
 * Like Promise.all, but fails only once every task has settled: a command that
 * returns while host calls are still in flight stops the plugin.
 */
async function settleAll<T>(tasks: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map(result => (result as PromiseFulfilledResult<T>).value);
}

/**
 * One run of the PCBWay workflow. Each round is a separate UI command so the panel can show progress;
 * the exports of a round run at the same time.
 */
export class PcbwaySession {
  private fab?: { exportId: string; doc: FabComponentsDoc };
  private exports = new Map<ExportStep, string>();
  private bundleId?: string;
  private quoteUrl?: string;
  private fileName = 'board.kicad_pcb';

  /**
   * `origin`: the PCBWay endpoint origin in the manifest (a mock's in test builds).
   * `wait`: the pause between busy retries (logic timers in QuickJS; tests pass their own).
   */
  constructor(private readonly api: ExportApi, private readonly origin = 'https://www.pcbway.com',
    private readonly wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); })) {}

  /**
   * Reads the component list with the `alongside` exports. With `batch` (the host has
   * exports.runMany) they are all one KiCad run, which loads the board once; without it only the
   * first runs next to the component list, and `export` does the rest. `exported`: the ones done.
   */
  async inspect(fileName: string, alongside: readonly ExportStep[] = [], batch = false): Promise<BoardSummary & { exported: ExportStep[] }> {
    this.fab = undefined;
    this.exports.clear();
    this.bundleId = undefined;
    this.quoteUrl = undefined;
    this.fileName = fileName;
    const exported = batch ? [...alongside] : alongside.slice(0, 1);
    let doc: FabComponentsDoc;
    if (batch) {
      const [fab, ...runs] = await this.busy(() => this.api.runMany(['fab-components', ...exported]));
      runs.forEach((run, i) => this.keep(exported[i]!, run!));
      ({ doc } = this.fab = await this.readComponents(fab!));
    } else {
      const components = this.busy(() => this.api.run('fab-components')).then(run => this.readComponents(run));
      await settleAll<unknown>([components, ...exported.map(kind => this.runExport(kind))]);
      ({ doc } = this.fab = await components);
    }
    const placed = doc.footprints.filter(fp => !fp.excludeFromPos);
    return {
      exported,
      fileName,
      widthMm: doc.board.widthMm,
      heightMm: doc.board.heightMm,
      copperLayers: doc.board.copperLayers,
      parts: doc.footprints.length,
      smd: placed.filter(fp => fp.smd).length,
      tht: placed.filter(fp => !fp.smd).length,
    };
  }

  /** Runs the exports at the same time. */
  async export(kinds: readonly ExportStep[]) {
    if (!this.fab) throw new Error('Read the board first.');
    const files = await settleAll(kinds.map(kind => this.runExport(kind)));
    return { files: files.reduce((total, count) => total + count, 0) };
  }

  private async readComponents(run: ExportRun) {
    const json = run.files.find(file => file.name.endsWith('.json'));
    if (!json) throw new Error('The component export produced no data.');
    return { exportId: run.exportId, doc: parseFabDoc(await this.api.readJson(run.exportId, json.name)) };
  }

  private async runExport(kind: ExportStep) {
    return this.keep(kind, await this.busy(() => this.api.run(kind)));
  }

  private keep(kind: ExportStep, run: ExportRun) {
    if (!run.files.length) throw new Error(`The ${kind} export produced no files.`);
    this.exports.set(kind, run.exportId);
    return run.files.length;
  }

  /** A busy export service is asked again a few times before giving up. */
  private async busy<T>(call: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'EXPORT_UNAVAILABLE' || attempt >= BUSY_RETRY_MS.length) throw error;
        await this.wait(BUSY_RETRY_MS[attempt]!);
      }
    }
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

  /** Upload the ZIP to PCBWay with the board size and layer count, as PCBWay's plugin does. */
  async send() {
    if (!this.bundleId || !this.fab) throw new Error('Build the ZIP first.');
    const { board } = this.fab.doc;
    const answer = await this.api.upload('pcbway', {
      path: PCBWAY_UPLOAD_PATH,
      bundleId: this.bundleId,
      fields: { boardWidth: board.widthMm.toFixed(2), boardHeight: board.heightMm.toFixed(2), boardLayer: String(board.copperLayers) },
    });
    if (answer.status !== 200) throw new Error(`PCBWay did not accept the upload (HTTP ${answer.status}).`);
    this.quoteUrl = quoteUrlFrom(answer.body, this.origin);
    return { quoteUrl: this.quoteUrl };
  }

  /** PCBJam asks the user, then opens PCBWay's quote page in a new tab. */
  async openQuote() {
    if (!this.quoteUrl) throw new Error('Send the ZIP to PCBWay first.');
    return this.api.openExternal(this.quoteUrl);
  }
}
