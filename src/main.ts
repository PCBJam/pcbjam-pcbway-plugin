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

// Runtime checks still protect against malformed UI messages: known exports, each at most once.
function exportKinds(value: unknown): ExportStep[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length || !value.every(kind => STEPS.includes(kind)))
    throw new Error('Unknown export.');
  return value;
}

pcbjam.handle('inspect', async (params: unknown): Promise<PluginCommands['inspect']['result']> => {
  const alongside = exportKinds((params as { alongside?: unknown } | null)?.alongside ?? []);
  const context = await pcbjam.context.get();
  if (context.tool !== 'pcbnew') throw new Error('Open a board in the PCB editor.');
  if (!context.methods.includes('exports.run')) throw new Error('This PCBJam does not offer exports here. Open a saved project.');
  return session.inspect(context.fileName, alongside);
});

pcbjam.handle('export', async (params: unknown): Promise<PluginCommands['export']['result']> => {
  const kinds = exportKinds((params as { kinds?: unknown } | null)?.kinds);
  if (!kinds.length) throw new Error('Unknown export.');
  return session.export(kinds);
});

pcbjam.handle('pack', (): Promise<PluginCommands['pack']['result']> => session.pack());
pcbjam.handle('download', (): Promise<PluginCommands['download']['result']> => session.download());
pcbjam.handle('send', (): Promise<PluginCommands['send']['result']> => session.send());
pcbjam.handle('openQuote', (): Promise<PluginCommands['openQuote']['result']> => session.openQuote());
