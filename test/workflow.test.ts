import { describe, expect, it } from 'vitest';
import { BUSY_RETRY_MS, PcbwaySession, parseFabDoc, quoteUrlFrom, zipNameFor, type ExportApi } from '../src/logic/workflow';

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
  const answer = (kind: Parameters<ExportApi['run']>[0]) => ({ exportId: `e${++n}-${kind}`, files: kind === 'fab-components' ? [{ name: 'fab-components.json', size: 10 }] : kind === 'ipc356' ? [{ name: 'netlist.ipc', size: 5 }] : [{ name: `${kind}.out`, size: 5 }] });
  const api: ExportApi = {
    run: async kind => { calls.push(['run', kind]); return answer(kind); },
    runMany: async kinds => { calls.push(['runMany', kinds]); return kinds.map(answer); },
    readJson: async (exportId, name) => { calls.push(['readJson', exportId, name]); return structuredClone(fabDoc); },
    bundle: async proposal => { calls.push(['bundle', proposal]); return { bundleId: 'b1', name: proposal.zipName, size: 1234, files: [] }; },
    saveBundle: async proposal => { calls.push(['saveBundle', proposal]); return { status: 'download-requested' }; },
    upload: async (endpointId, request) => { calls.push(['upload', endpointId, request]); return { status: 200, body: { redirect: 'https://www.pcbway.com/project/quote/123' } }; },
    openExternal: async url => { calls.push(['openExternal', url]); return { status: 'opened' }; },
    ...overrides,
  };
  return { api, calls };
}

describe('PCBWay workflow', () => {
  it('reads the component list, runs the three exports and bundles them with PCBWay file names', async () => {
    const { api, calls } = fakeApi();
    const session = new PcbwaySession(api);
    // An older host: Gerbers with the component list, the rest in the next round.
    expect(await session.inspect('boards/Main Board (v2).kicad_pcb', ['gerbers', 'drill', 'ipc356'])).toEqual({ exported: ['gerbers'], fileName: 'boards/Main Board (v2).kicad_pcb', widthMm: 50, heightMm: 30, copperLayers: 2, parts: 2, smd: 1, tht: 1 });
    expect(await session.export(['drill', 'ipc356'])).toEqual({ files: 2 });
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

  it('runs everything in one batch when the host has exports.runMany', async () => {
    const { api, calls } = fakeApi();
    const session = new PcbwaySession(api);
    expect(await session.inspect('a.kicad_pcb', ['gerbers', 'drill', 'ipc356'], true)).toMatchObject({ exported: ['gerbers', 'drill', 'ipc356'], parts: 2 });
    expect(calls.map(call => call[0])).toEqual(['runMany', 'readJson']);
    expect(calls[0]).toEqual(['runMany', ['fab-components', 'gerbers', 'drill', 'ipc356']]);
    expect(calls[1]).toEqual(['readJson', 'e1-fab-components', 'fab-components.json']);
    await session.pack();
    const [, proposal] = calls.find(call => call[0] === 'bundle') as [string, Parameters<ExportApi['bundle']>[0]];
    expect(proposal.parts.map(part => part.exportId)).toEqual(['e2-gerbers', 'e3-drill', 'e4-ipc356']);
  });

  it('asks a busy export service again for a batch too', async () => {
    const { api } = fakeApi();
    const waits: number[] = [];
    let busyTimes = 1;
    const session = new PcbwaySession({ ...api, runMany: async kinds => {
      if (busyTimes-- > 0) throw Object.assign(new Error('busy'), { code: 'EXPORT_UNAVAILABLE' });
      return api.runMany(kinds);
    } }, undefined, async ms => { waits.push(ms); });
    await session.inspect('a.kicad_pcb', ['gerbers', 'drill', 'ipc356'], true);
    expect(waits).toEqual([BUSY_RETRY_MS[0]]);
    expect((await session.pack()).name).toBe('a.kicad_pcb.zip');
  });

  it('refuses steps out of order and a fresh inspect forgets the previous run', async () => {
    const session = new PcbwaySession(fakeApi().api);
    await expect(session.export(['gerbers'])).rejects.toThrow('Read the board first');
    await expect(session.download()).rejects.toThrow('Build the ZIP first');
    await session.inspect('a.kicad_pcb');
    await session.export(['gerbers']);
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

  it('starts the exports of a round together and settles all of them before failing', async () => {
    const { api } = fakeApi();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const together = new PcbwaySession({ ...api, run: async kind => { started.push(kind); await gate; return api.run(kind); } });
    const inspecting = together.inspect('a.kicad_pcb', ['gerbers']);
    expect(started).toEqual(['fab-components', 'gerbers']);
    release();
    await inspecting;

    // A command that returns with host calls in flight stops the plugin: the failure waits for ipc356.
    let finishIpc!: () => void, ipcDone = false;
    const slowIpc = new Promise<void>(resolve => { finishIpc = resolve; });
    const failing = new PcbwaySession({ ...api, run: async kind => {
      if (kind === 'drill') throw new Error('drill broke');
      if (kind === 'ipc356') { await slowIpc; ipcDone = true; }
      return api.run(kind);
    } });
    await failing.inspect('a.kicad_pcb');
    let failed = false;
    const exporting = failing.export(['drill', 'ipc356']).catch(error => { failed = true; throw error; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(failed).toBe(false);
    finishIpc();
    await expect(exporting).rejects.toThrow('drill broke');
    expect(ipcDone).toBe(true);
  });

  it('asks a busy export service again, and only a busy one', async () => {
    const { api } = fakeApi();
    const busy = () => Object.assign(new Error('The export service is busy or unavailable. Try again shortly.'), { code: 'EXPORT_UNAVAILABLE' });
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    let busyTimes = 2;
    const recovers = new PcbwaySession({ ...api, run: async kind => { if (kind === 'gerbers' && busyTimes-- > 0) throw busy(); return api.run(kind); } }, undefined, wait);
    await recovers.inspect('a.kicad_pcb', ['gerbers']);
    expect(waits).toEqual([1000, 2000]);

    waits.length = 0;
    const staysBusy = new PcbwaySession({ ...api, run: async kind => { if (kind === 'drill') throw busy(); return api.run(kind); } }, undefined, wait);
    await staysBusy.inspect('a.kicad_pcb');
    await expect(staysBusy.export(['drill'])).rejects.toThrow('busy');
    expect(waits).toEqual(BUSY_RETRY_MS);

    waits.length = 0;
    const broken = new PcbwaySession({ ...api, run: async () => { throw Object.assign(new Error('Export failed: no outline'), { code: 'EXPORT_FAILED' }); } }, undefined, wait);
    await expect(broken.inspect('a.kicad_pcb')).rejects.toThrow('no outline');
    expect(waits).toEqual([]);
  });

  it('makes ZIP names PCBJam accepts', () => {
    expect(zipNameFor('main.kicad_pcb')).toBe('main.kicad_pcb.zip');
    expect(zipNameFor('dir/Ünïcode board.kicad_pcb')).toBe('n_code board.kicad_pcb.zip');
    expect(zipNameFor('___')).toBe('board.zip');
    expect(zipNameFor('x'.repeat(200) + '.kicad_pcb')).toMatch(/^x{86}\.zip$/);
  });
});

describe('Send to PCBWay', () => {
  const built = async (overrides: Partial<ExportApi> = {}, origin?: string) => {
    const fake = fakeApi(overrides);
    const session = new PcbwaySession(fake.api, origin);
    await session.inspect('main.kicad_pcb');
    await session.export(['gerbers', 'drill', 'ipc356']);
    await session.pack();
    return { session, calls: fake.calls };
  };

  it('uploads the bundle with board size and layers, then opens the quote PCBWay returned', async () => {
    const { session, calls } = await built();
    expect(await session.send()).toEqual({ quoteUrl: 'https://www.pcbway.com/project/quote/123' });
    expect(calls.find(call => call[0] === 'upload')).toEqual(['upload', 'pcbway', { path: '/Common/KiCadUpFile/', bundleId: 'b1', fields: { boardWidth: '50.00', boardHeight: '30.00', boardLayer: '2' } }]);
    expect(await session.openQuote()).toEqual({ status: 'opened' });
    expect(calls.at(-1)).toEqual(['openExternal', 'https://www.pcbway.com/project/quote/123']);
  });

  it('never offers a link outside PCBWay or a failed upload', async () => {
    for (const body of [{ redirect: 'https://evil.example/pcbway.com' }, { redirect: 'http://www.pcbway.com/q' }, { redirect: 'https://user:pw@www.pcbway.com/q' }, { redirect: 'javascript:alert(1)' }, {}, null]) {
      const { session } = await built({ upload: async () => ({ status: 200, body }) });
      await expect(session.send()).rejects.toThrow(/PCBWay answered/);
      await expect(session.openQuote()).rejects.toThrow('Send the ZIP to PCBWay first');
    }
    const { session } = await built({ upload: async () => ({ status: 500, body: { error: 'x' } }) });
    await expect(session.send()).rejects.toThrow('HTTP 500');
    expect(quoteUrlFrom({ redirect: 'https://member.pcbway.com/cart' }, 'https://www.pcbway.com')).toBe('https://member.pcbway.com/cart');
  });

  it('a mock build checks links against the mock origin', async () => {
    const { session } = await built({ upload: async () => ({ status: 200, body: { redirect: 'https://pcbway-mock.example/mock-quote/1' } }) }, 'https://pcbway-mock.example');
    expect(await session.send()).toEqual({ quoteUrl: 'https://pcbway-mock.example/mock-quote/1' });
  });

  it('refuses to send before the ZIP is built', async () => {
    await expect(new PcbwaySession(fakeApi().api).send()).rejects.toThrow('Build the ZIP first');
  });
});
