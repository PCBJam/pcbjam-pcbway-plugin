/** Shared between QuickJS logic and the React UI. No browser or host objects. */
export type ExportStep = 'gerbers' | 'drill' | 'ipc356';

export interface BoardSummary {
  fileName: string;
  widthMm: number;
  heightMm: number;
  copperLayers: number;
  parts: number;
  smd: number;
  tht: number;
}

export interface BundleSummary {
  name: string;
  size: number;
  files: { name: string; size: number }[];
}

export interface PluginCommands {
  /** `alongside`: exports that run while the component list is read. */
  inspect: { params: { alongside?: ExportStep[] }; result: BoardSummary };
  /** The exports run at the same time. */
  export: { params: { kinds: ExportStep[] }; result: { files: number } };
  pack: { params: Record<string, never>; result: BundleSummary };
  download: { params: Record<string, never>; result: { status: 'download-requested' | 'cancelled' } };
  send: { params: Record<string, never>; result: { quoteUrl: string } };
  openQuote: { params: Record<string, never>; result: { status: 'opened' | 'cancelled' } };
}
