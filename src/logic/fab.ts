/**
 * PCBWay BOM + positions CSV builders — pure functions over PCBJam's
 * `fab-components` export. Moved unchanged from PCBJam's first PCBWay
 * integration (packages/plugin-pcbway, by Gergő Törcsvári).
 *
 * The column set, field-alias tables, grouping and skip rules are ported
 * from the official PCBWay KiCad plugin so PCBWay's quote parser sees the
 * files it already knows: PCBWay-Plug-in-for-Kicad (MIT, © 2022 PCBWay,
 * Aisler and contributors), plugins/process.py + utils.py @ d15ae69.
 */

export interface FabFootprint {
  ref: string;
  fpid: string;
  side: "top" | "bottom";
  posMm: { x: number; y: number };
  rotationDeg: number;
  smd: boolean;
  excludeFromPos: boolean;
  excludeFromBom: boolean;
  dnp: boolean;
  fields: Record<string, string>;
}

export interface FabComponentsDoc {
  board: {
    widthMm: number;
    heightMm: number;
    bboxOriginMm: { x: number; y: number };
    auxOriginMm: { x: number; y: number };
    copperLayers: number;
    thicknessMm: number;
  };
  footprints: FabFootprint[];
}

/** Exact key preference order from the plugin's utils.py. */
const MPN_KEYS = [
  "mpn",
  "MPN",
  "Mpn",
  "PCBWay_MPN",
  "part number",
  "Part Number",
  "Part No.",
  "Mfr. Part No.",
  "Mfg Part",
  "Manufacturer_Part_Number",
];
const PACKAGE_KEYS = [
  "pack",
  "PACK",
  "Pack",
  "package",
  "PACKAGE",
  "Package",
  "case",
  "CASE",
  "Case",
];

/** Fixed fields that never become extra BOM columns. */
const NON_EXTRA_FIELDS = new Set([
  "ki_fp_filters",
  "Reference",
  "Value",
  "Datasheet",
  "Footprint",
]);

function firstField(fields: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const v = fields[key];
    if (v) return v;
  }
  return "";
}

function isDnp(fp: FabFootprint): boolean {
  if (fp.dnp) return true;
  if ((fp.fields["Value"] ?? "") === "DNP") return true;
  return Object.keys(fp.fields).some((k) => k.toLowerCase() === "dnp" && fp.fields[k]);
}

/** Footprint name = the FPID's item name (after the lib nickname). */
function footprintName(fpid: string): string {
  const colon = fpid.indexOf(":");
  return colon >= 0 ? fpid.slice(colon + 1) : fpid;
}

/** Findings W-3: a cell starting with a formula metacharacter is evaluated
 *  by Excel/LibreOffice on open; board field values (and custom field NAMES,
 *  which become header cells) are attacker-controlled. Prefix with `'` unless
 *  the cell is a plain number (negative coordinates must stay numeric). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function csvCell(value: string): string {
  const safe = FORMULA_LEAD.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csv(rows: string[][]): string {
  // UTF-8 BOM, like the plugin's csv output (Excel-friendly).
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * PCBWay_positions.csv — aux-origin-relative mm, Y negated (KiCad's Y grows
 * downward; PCBWay wants up), both sides in one file. Skips
 * exclude-from-pos footprints and `**` designators (plugin parity).
 */
export function buildPositionsCsv(doc: FabComponentsDoc): string {
  const aux = doc.board.auxOriginMm;
  const rows: string[][] = [
    [
      "pos_x",
      "pos_y",
      "rotation",
      "side",
      "designator",
      "mpn",
      "pack",
      "footprint",
      "value",
      "mount_type",
    ],
  ];
  for (const fp of doc.footprints) {
    if (fp.excludeFromPos) continue;
    if (fp.ref.includes("**")) continue;
    rows.push([
      String(round4(fp.posMm.x - aux.x)),
      String(round4((fp.posMm.y - aux.y) * -1)),
      String(round4(fp.rotationDeg)),
      fp.side,
      fp.ref,
      firstField(fp.fields, MPN_KEYS),
      firstField(fp.fields, PACKAGE_KEYS),
      footprintName(fp.fpid),
      fp.fields["Value"] ?? "",
      fp.smd ? "smt" : "tht",
    ]);
  }
  return csv(rows);
}

interface BomGroup {
  refs: string[];
  value: string;
  footprint: string;
  pack: string;
  mpn: string;
  dnp: boolean;
  mountType: string;
  /** extra column → per-ref values (conflict cells render the ref lists). */
  extras: Map<string, Map<string, string[]>>;
}

/**
 * PCBWay_bom.csv — grouped by value+footprint+package+MPN (DNP parts never
 * group), fixed columns then every other non-empty field as an extra column.
 * Conflicting extra values within a group render as
 * `[R1,R2]valA; [R3]valB` (plugin parity).
 */
export function buildBomCsv(doc: FabComponentsDoc): string {
  const groups = new Map<string, BomGroup>();
  const extraColumns: string[] = [];

  const aliasKeys = new Set([...MPN_KEYS, ...PACKAGE_KEYS]);

  for (const fp of doc.footprints) {
    if (fp.excludeFromBom) continue;
    if (fp.ref.includes("**")) continue;
    const value = fp.fields["Value"] ?? "";
    const fpName = footprintName(fp.fpid);
    const pack = firstField(fp.fields, PACKAGE_KEYS);
    const mpn = firstField(fp.fields, MPN_KEYS);
    const dnp = isDnp(fp);
    // DNP parts get their designator baked into the key → one row each.
    const key = `${dnp ? fp.ref + "_" : ""}${value}_${fpName}_${pack}_${mpn}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        refs: [],
        value,
        footprint: fpName,
        pack,
        mpn,
        dnp,
        mountType: fp.smd ? "smt" : "tht",
        extras: new Map(),
      };
      groups.set(key, group);
    }
    group.refs.push(fp.ref);

    for (const [name, fieldValue] of Object.entries(fp.fields)) {
      if (!fieldValue) continue;
      if (NON_EXTRA_FIELDS.has(name) || aliasKeys.has(name)) continue;
      if (name.toLowerCase() === "dnp") continue;
      // A custom field colliding with a fixed column keeps its data under a
      // renamed header (plugin parity).
      const column =
        name.toUpperCase() === "MOUNT_TYPE" ? `Custom_${name}` : name;
      if (!extraColumns.includes(column)) extraColumns.push(column);
      let perValue = group.extras.get(column);
      if (!perValue) {
        perValue = new Map();
        group.extras.set(column, perValue);
      }
      const refs = perValue.get(fieldValue) ?? [];
      refs.push(fp.ref);
      perValue.set(fieldValue, refs);
    }
  }

  const rows: string[][] = [
    [
      "Designator",
      "Quantity",
      "Value",
      "Footprint",
      "Package",
      "MPN",
      "DNP",
      "Mount_Type",
      ...extraColumns,
    ],
  ];

  for (const group of groups.values()) {
    const extraCells = extraColumns.map((column) => {
      const perValue = group.extras.get(column);
      if (!perValue) return "";
      if (perValue.size === 1) return [...perValue.keys()][0]!;
      return [...perValue.entries()]
        .map(([v, refs]) => `[${refs.join(",")}]${v}`)
        .join("; ");
    });
    rows.push([
      group.refs.join(","),
      String(group.refs.length),
      group.value,
      group.footprint,
      group.pack,
      group.mpn,
      group.dnp ? "Yes" : "",
      group.mountType,
      ...extraCells,
    ]);
  }

  return csv(rows);
}
