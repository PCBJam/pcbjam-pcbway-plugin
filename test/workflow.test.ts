import { describe, expect, it } from 'vitest';
import { PcbwaySession, parseFabDoc, zipNameFor, type ExportApi } from '../src/logic/workflow';

const fabDoc = {
  board: { widthMm: 50, heightMm: 30, bboxOriginMm: { x: 0, y: 0 }, auxOriginMm: { x: 10, y: 10 }, copperLayers: 2, thicknessMm: 1.6 },
  footprints: [
    { ref: 'R1', fpid: 'Resistor_SMD:R_0603_1608Metric', side: 'top', posMm: { x: 20, y: 20 }, rotationDeg: 90, smd: true, excludeFromPos: false, excludeFromBom: false, dnp: false, fields: { Value: '10k' } },
    { ref: 'J1', fpid: 'Connector:Pin_1x02', side: 'top', posMm: { x: 30, y: 20 }, rotationDeg: 0, smd: false, excludeFromPos: false, excludeFromBom: false, dnp: false, fields: { Value: 'Conn' } },
  ],
};

/** A fake host: records calls, answers like PCBJam's export API. */
function fakeApi(overrides: Partial<ExportApi> = {}) {
  const calls: unknown[][] = [];
  let n = 0;
  const api: ExportApi = {
    run: async kind => { calls.push(['run', kind]); return { exportId: `e${++n}-${kind}`, files: kind === 'fab-components' ? [{ name: 'fab-components.json', size: 10 }] : kind === 'ipc356' ? [{ name: 'netlist.ipc', size: 5 }] : [{ name: `${kind}.out`, size: 5 }] }; },
    readJson: async (exportId, name) => { calls.push(['readJson', exportId, name]); return structuredClone(fabDoc); },
    bundle: async proposal => { calls.push(['bundle', proposal]); return { bundleId: 'b1', name: proposal.zipName, size: 1234, files: [] }; },
    saveBundle: async proposal => { calls.push(['saveBundle', proposal]); return { status: 'download-requested' }; },
    ...overrides,
  };
  return { api, calls };
}

describe('PCBWay workflow', () => {
  it('reads the component list, runs the three exports and bundles them with PCBWay file names', async () => {
    const { api, calls } = fakeApi();
    const session = new PcbwaySession(api);
    expect(await session.inspect('boards/Main Board (v2).kicad_pcb')).toEqual({ fileName: 'boards/Main Board (v2).kicad_pcb', widthMm: 50, heightMm: 30, copperLayers: 2, parts: 2, smd: 1, tht: 1 });
    for (const kind of ['gerbers', 'drill', 'ipc356'] as const) await session.export(kind);
    const bundle = await session.pack();
    expect(bundle.name).toBe('Main Board _v2_.kicad_pcb.zip');
    const [, proposal] = calls.find(call => call[0] === 'bundle') as [string, Parameters<ExportApi['bundle']>[0]];
    expect(proposal.parts).toEqual([
      { exportId: 'e2-gerbers' },
      { exportId: 'e3-drill' },
      { exportId: 'e4-ipc356', rename: { 'netlist.ipc': 'PCBWay_netlist.ipc' } },
    ]);
    expect(proposal.extraFiles!.map(f => f.name)).toEqual(['PCBWay_bom.csv', 'PCBWay_positions.csv']);
    expect(proposal.extraFiles![0]!.text).toContain('10k');
    expect(proposal.extraFiles![1]!.text).toContain('R1');
    expect(await session.download()).toEqual({ status: 'download-requested' });
    expect(calls.at(-1)).toEqual(['saveBundle', { bundleId: 'b1' }]);
  });

  it('refuses steps out of order and a fresh inspect forgets the previous run', async () => {
    const session = new PcbwaySession(fakeApi().api);
    await expect(session.export('gerbers')).rejects.toThrow('Read the board first');
    await expect(session.download()).rejects.toThrow('Build the ZIP first');
    await session.inspect('a.kicad_pcb');
    await session.export('gerbers');
    await expect(session.pack()).rejects.toThrow('Missing exports: drill, ipc356');
    await session.inspect('a.kicad_pcb');
    await expect(session.pack()).rejects.toThrow('Missing exports: gerbers, drill, ipc356');
  });

  it('rejects a malformed component export and empty exports', async () => {
    expect(() => parseFabDoc({ board: {}, footprints: [] })).toThrow('unexpected format');
    expect(() => parseFabDoc({ ...fabDoc, footprints: [{ ...fabDoc.footprints[0], posMm: { x: 'a' } }] })).toThrow('unexpected format');
    const session = new PcbwaySession(fakeApi({ run: async () => ({ exportId: 'x', files: [] }) }).api);
    await expect(session.inspect('a.kicad_pcb')).rejects.toThrow('produced no data');
  });

  it('makes ZIP names PCBJam accepts', () => {
    expect(zipNameFor('main.kicad_pcb')).toBe('main.kicad_pcb.zip');
    expect(zipNameFor('dir/Ünïcode board.kicad_pcb')).toBe('n_code board.kicad_pcb.zip');
    expect(zipNameFor('___')).toBe('board.zip');
    expect(zipNameFor('x'.repeat(200) + '.kicad_pcb')).toMatch(/^x{86}\.zip$/);
  });
});
