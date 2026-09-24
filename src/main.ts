import type { ExportStep, PluginCommands } from './contracts';
import { PcbwaySession } from './logic/workflow';

// The PCBWay endpoint origin in manifest.json; build.mjs sets it (a mock's in test builds).
declare const PCBWAY_ORIGIN: string;

// These handlers run in QuickJS. React and browser APIs belong in src/ui/.
const session = new PcbwaySession({
  run: kind => pcbjam.exports.run(kind),
  readJson: (exportId, name) => pcbjam.exports.readJson(exportId, name),
  bundle: proposal => pcbjam.exports.bundle(proposal),
  saveBundle: proposal => pcbjam.files.saveBundle(proposal),
  upload: (endpointId, request) => pcbjam.http.upload(endpointId, request),
  openExternal: url => pcbjam.ui.openExternal(url),
}, PCBWAY_ORIGIN);

const STEPS: ExportStep[] = ['gerbers', 'drill', 'ipc356'];

pcbjam.handle('inspect', async (): Promise<PluginCommands['inspect']['result']> => {
  const context = await pcbjam.context.get();
  if (context.tool !== 'pcbnew') throw new Error('Open a board in the PCB editor.');
  if (!context.methods.includes('exports.run')) throw new Error('This PCBJam does not offer exports here. Open a saved project.');
  return session.inspect(context.fileName);
});

pcbjam.handle('export', async (params: unknown): Promise<PluginCommands['export']['result']> => {
  // Runtime checks still protect against malformed UI messages.
  const kind = (params as { kind?: unknown } | null)?.kind;
  if (typeof kind !== 'string' || !STEPS.includes(kind as ExportStep)) throw new Error('Unknown export.');
  return session.export(kind as ExportStep);
});

pcbjam.handle('pack', (): Promise<PluginCommands['pack']['result']> => session.pack());
pcbjam.handle('download', (): Promise<PluginCommands['download']['result']> => session.download());
pcbjam.handle('send', (): Promise<PluginCommands['send']['result']> => session.send());
pcbjam.handle('openQuote', (): Promise<PluginCommands['openQuote']['result']> => session.openQuote());
