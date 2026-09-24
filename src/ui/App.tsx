import { useState } from 'react';
import type { BoardSummary, BundleSummary, ExportStep } from '../contracts';
import { callPlugin } from './pcbjam';

type StepId = 'inspect' | ExportStep | 'pack';
const STEPS: { id: StepId; label: string }[] = [
  { id: 'inspect', label: 'Reading components' },
  { id: 'gerbers', label: 'Generating Gerbers' },
  { id: 'drill', label: 'Generating drill files' },
  { id: 'ipc356', label: 'Generating IPC-356 netlist' },
  { id: 'pack', label: 'Building BOM, placement and ZIP' },
];

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; step: number }
  | { kind: 'done'; board: BoardSummary; bundle: BundleSummary }
  | { kind: 'failed'; step: number; message: string };

const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [saved, setSaved] = useState('');

  async function generate() {
    setSaved('');
    let step = 0;
    try {
      setPhase({ kind: 'running', step });
      const summary = await callPlugin('inspect', {});
      setBoard(summary);
      for (const kind of ['gerbers', 'drill', 'ipc356'] as const) {
        setPhase({ kind: 'running', step: ++step });
        await callPlugin('export', { kind });
      }
      setPhase({ kind: 'running', step: ++step });
      const bundle = await callPlugin('pack', {});
      setPhase({ kind: 'done', board: summary, bundle });
    } catch (error) {
      setPhase({ kind: 'failed', step, message: message(error) });
    }
  }

  async function download() {
    try {
      const result = await callPlugin('download', {});
      setSaved(result.status === 'download-requested' ? 'Download started.' : 'Download cancelled.');
    } catch (error) {
      setSaved(message(error));
    }
  }

  const running = phase.kind === 'running';
  return (
    <main>
      <h1>PCBWay</h1>
      <p>
        Build the files PCBWay needs to quote and make this board: Gerbers, drill files, an IPC-356 netlist, and
        PCBWay's BOM and placement CSVs, in one ZIP. PCBJam generates them on its servers from the saved project.
      </p>
      {phase.kind === 'idle' && <button onClick={generate}>Generate PCBWay ZIP</button>}
      {(phase.kind === 'running' || phase.kind === 'failed') && (
        <ol className="steps" aria-label="Progress">
          {STEPS.map((step, index) => {
            const state = phase.kind === 'failed' && index === phase.step ? 'failed' : index < phase.step ? 'done' : index === phase.step && running ? 'active' : 'waiting';
            return <li key={step.id} data-state={state}>{state === 'done' ? '✓ ' : state === 'failed' ? '✕ ' : state === 'active' ? '… ' : ''}{step.label}</li>;
          })}
        </ol>
      )}
      {phase.kind === 'failed' && (
        <>
          <p role="alert" className="error">{phase.message}</p>
          <button onClick={generate}>Start over</button>
        </>
      )}
      {phase.kind === 'done' && (
        <section aria-label="PCBWay ZIP">
          <p className="summary">
            <strong>{phase.bundle.name}</strong> · {size(phase.bundle.size)}<br />
            Board {phase.board.widthMm.toFixed(1)} × {phase.board.heightMm.toFixed(1)} mm, {phase.board.copperLayers} copper layers,
            {' '}{phase.board.parts} parts ({phase.board.smd} SMD, {phase.board.tht} through-hole)
          </p>
          <button onClick={download}>Download ZIP</button>
          {saved && <p className="status" role="status">{saved}</p>}
          <details>
            <summary>{phase.bundle.files.length} files</summary>
            <ul className="files">{phase.bundle.files.map(file => <li key={file.name}>{file.name} <span>{size(file.size)}</span></li>)}</ul>
          </details>
          <p className="note">
            Next: upload this ZIP on PCBWay's online PCB quote page. Sending it to PCBWay directly from PCBJam is coming.
          </p>
          <button className="secondary" onClick={generate}>Generate again</button>
        </section>
      )}
      {board && phase.kind === 'failed' && <p className="file">{board.fileName}</p>}
    </main>
  );
}
