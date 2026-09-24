# PCBWay for PCBJam

A [PCBJam](https://pcbjam.com) plugin for the PCB editor that builds a
**PCBWay-ready ZIP** of the open board:

- Gerbers and drill files, made by KiCad's own exporters on PCBJam's servers
- an IPC-356 netlist (`PCBWay_netlist.ipc`)
- PCBWay's BOM and placement CSVs (`PCBWay_bom.csv`, `PCBWay_positions.csv`),
  using the column set and rules of
  [PCBWay's KiCad plugin](https://github.com/pcbway/PCBWay-Plug-in-for-Kicad)

**Send to PCBWay** uploads the ZIP with the board size and layer count to
PCBWay's KiCad upload endpoint, the way PCBWay's own KiCad plugin does, and
opens the quote page PCBWay returns in a new browser tab (after you confirm).
Or download the ZIP and upload it on PCBWay's site yourself.

It uses only PCBJam's public plugin API (`pcbjam.exports.*`,
`pcbjam.files.saveBundle`, `pcbjam.http.upload`, `pcbjam.ui.openExternal`);
the file bytes never enter the plugin sandbox.

## Testing without PCBWay

PCBWay has no public sandbox. `mock/` is a stand-in for its upload endpoint
that checks what the plugin sends and serves a quote page listing it:

```sh
npm run mock                                       # http://127.0.0.1:3058
cloudflared tunnel --url http://127.0.0.1:3058     # an https name for it
PUBLIC_ORIGIN=https://<name>.trycloudflare.com npm run mock
PCBWAY_ORIGIN=https://<name>.trycloudflare.com npm run build   # dist/pcbway-mock.zip, "PCBWay (mock)"
```

Publish the mock build on a PCBJam test stack and approve its endpoint; the
real build (`npm run build`) always targets `https://www.pcbway.com`.

> **Availability:** PCBJam's plugin platform is currently on the staging editor
> only. Install the plugin from the PCBJam marketplace (`/plugins`); questions
> on the [PCBJam Discord](https://discord.gg/ybhqJxjR3E).

## Building from source

```sh
npm ci
npm test           # BOM/placement CSV rules and the workflow against a fake host
npm run build      # dist/plugin/ and dist/pcbway.zip
```

Plugin logic is in `src/main.ts` and `src/logic/` (runs in PCBJam's QuickJS
sandbox), the panel in `src/ui/` (React). The CSV builders in
`src/logic/fab.ts` come from PCBJam's first PCBWay integration by
Gergő Törcsvári, ported from PCBWay's MIT-licensed KiCad plugin.

## License

MIT, see [LICENSE](LICENSE).
