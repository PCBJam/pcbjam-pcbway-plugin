# PCBWay for PCBJam

A [PCBJam](https://pcbjam.com) plugin for the PCB editor that builds a
**PCBWay-ready ZIP** of the open board:

- Gerbers and drill files, made by KiCad's own exporters on PCBJam's servers
- an IPC-356 netlist (`PCBWay_netlist.ipc`)
- PCBWay's BOM and placement CSVs (`PCBWay_bom.csv`, `PCBWay_positions.csv`),
  using the column set and rules of
  [PCBWay's KiCad plugin](https://github.com/pcbway/PCBWay-Plug-in-for-Kicad)

Download the ZIP and upload it on PCBWay's online quote page. Sending it to
PCBWay directly from PCBJam is planned.

It uses only PCBJam's public plugin API (`pcbjam.exports.*`,
`pcbjam.files.saveBundle`); the file bytes never enter the plugin sandbox.

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
