import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
// @ts-expect-error plain ESM helper without types
import { startPcbwayMock } from '../mock/pcbway-mock.mjs';

describe('mock PCBWay', () => {
  let mock: { origin: string; uploads: Map<string, unknown>; close(): Promise<void> };
  beforeAll(async () => { mock = await startPcbwayMock({ port: 0, publicOrigin: 'https://pcbway-mock.example' }); });
  afterAll(() => mock.close());
  const post = (form: FormData) => fetch(mock.origin + '/Common/KiCadUpFile/', { method: 'POST', body: form });
  const zip = () => new Blob([zipSync({ 'board-F_Cu.gbr': strToU8('G04*'), 'PCBWay_bom.csv': strToU8('a') })], { type: 'application/zip' });

  it('accepts what the plugin sends and serves a quote page for it', async () => {
    const form = new FormData();
    form.set('boardWidth', '50.00'); form.set('boardHeight', '30.00'); form.set('boardLayer', '2');
    form.set('upload[file]', zip(), 'board.kicad_pcb.zip');
    const response = await post(form);
    expect(response.headers.get('content-type')).toBe('application/json');
    const { redirect } = (await response.json()) as { redirect: string };
    expect(redirect).toMatch(/^https:\/\/pcbway-mock\.example\/mock-quote\/[0-9a-f-]{36}$/);
    const page = await (await fetch(mock.origin + new URL(redirect).pathname)).text();
    expect(page).toContain('board.kicad_pcb.zip');
    expect(page).toContain('50.00 × 30.00 mm, 2 layers, 2 files');
  });

  it('rejects a missing file, a non-ZIP and missing board fields', async () => {
    const base = () => { const f = new FormData(); f.set('boardWidth', '1'); f.set('boardHeight', '1'); f.set('boardLayer', '2'); return f; };
    expect((await post(base())).status).toBe(400);
    const notZip = base(); notZip.set('upload[file]', new Blob(['<html>']), 'x.zip');
    expect((await post(notZip)).status).toBe(400);
    const noLayers = new FormData(); noLayers.set('upload[file]', zip(), 'x.zip');
    expect((await post(noLayers)).status).toBe(400);
  });
});
