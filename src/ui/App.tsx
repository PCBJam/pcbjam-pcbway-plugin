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
  const [sending, setSending] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [sendError, setSendError] = useState('');

  async function generate() {
    setSaved('');
    setSending('idle');
    setSendError('');
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

  async function send() {
    setSending('sending');
    setSendError('');
    try {
      await callPlugin('send', {});
      setSending('sent');
    } catch (error) {
      setSending('idle');
      setSendError(message(error));
    }
  }

  async function openQuote() {
    try {
      const result = await callPlugin('openQuote', {});
      if (result.status === 'cancelled') setSendError('Opening PCBWay was cancelled. You can open the quote again.');
    } catch (error) {
      setSendError(message(error));
    }
  }

  const running = phase.kind === 'running';
  return (
    <main>
      <h1>PCBWay</h1>
      <p>
        Send this board to PCBWay for a quote. PCBJam builds the files PCBWay needs on its servers from the saved
        project: Gerbers, drill files, an IPC-356 netlist, and PCBWay's BOM and placement CSVs, in one ZIP.
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
          {sending === 'sent' ? (
            <>
              <p className="status" role="status">Uploaded to PCBWay. Review the quote and order on PCBWay's site.</p>
              <button onClick={openQuote}>Open PCBWay quote</button>
            </>
          ) : (
            <button onClick={send} disabled={sending === 'sending'}>{sending === 'sending' ? 'Sending to PCBWay…' : 'Send to PCBWay'}</button>
          )}
          {sendError && <p role="alert" className="error">{sendError}</p>}
          <button className="secondary" onClick={download}>Download ZIP</button>
          {saved && <p className="status">{saved}</p>}
          <details>
            <summary>{phase.bundle.files.length} files</summary>
            <ul className="files">{phase.bundle.files.map(file => <li key={file.name}>{file.name} <span>{size(file.size)}</span></li>)}</ul>
          </details>
          <p className="note">
            Send uploads the ZIP with the board size and layer count to PCBWay, the way PCBWay's KiCad plugin does, and
            opens their quote page in a new tab. Or download the ZIP and upload it on PCBWay's site yourself.
          </p>
          <button className="secondary" onClick={generate}>Generate again</button>
        </section>
      )}
      {board && phase.kind === 'failed' && <p className="file">{board.fileName}</p>}
    </main>
  );
}
