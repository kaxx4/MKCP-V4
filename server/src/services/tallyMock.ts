/**
 * A Tally that is not Tally.
 *
 * ── Why this has to exist ─────────────────────────────────────────────────
 *
 * There is no mock today. `server/scripts/mock-run-all.ts` — the file literally
 * named "mock" — points at the live company. Every one of the ~30 scripts that
 * exercises a parser needs TallyPrime running, the right company open, and the
 * single-threaded XML port free.
 *
 * That matters most for the thing that most needs testing. Fourteen of the
 * twenty-four read builders parse with hand-rolled regex, each with a
 * documented near-miss, and the only way to prove one handles a shape is to
 * feed it that shape. Some shapes — an unrecognised object type, a malformed
 * envelope — **cannot be produced against a live Tally at all**: a bad object
 * type raises a modal dialog that blocks the port until a human restarts the
 * application (guardrail P6).
 *
 * So: capture what Tally really answers, replay it from disk, and fuzz against
 * the replay.
 *
 * ── What makes a fixture match ────────────────────────────────────────────
 *
 * The request ID, because that is what identifies a shape and it is already
 * unique per builder. Matching on the whole body would make every fixture
 * brittle to a whitespace change; matching on the object type alone would
 * collapse shapes that differ only in their fetch list.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface Fixture {
  /** The request ID this fixture answers. */
  id: string;
  /** What it is, for a human reading the directory. */
  label: string;
  capturedAt: string;
  requestXml: string;
  responseXml: string;
  /** Milliseconds the real Tally took. Replayed as metadata, not as a delay. */
  elapsedMs: number;
}

type Transport = (url: string, xml: string, timeoutMs: number) => Promise<string>;

let installed: Transport | null = null;

/** The hook `tallyPost` consults. Null means "talk to the real thing". */
export function mockTransport(): Transport | null {
  return installed;
}

export function installMock(t: Transport): void {
  installed = t;
}

export function uninstallMock(): void {
  installed = null;
}

// ── A fixture directory ───────────────────────────────────────────────────

const idOf = (xml: string): string => xml.match(/<ID[^>]*>([^<]+)<\/ID>/i)?.[1]?.trim() ?? "";

export class FixtureStore {
  private byId = new Map<string, Fixture>();

  constructor(private dir: string) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      try {
        const fx = JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture;
        this.byId.set(fx.id.toLowerCase(), fx);
      } catch { /* a corrupt fixture is not worth taking the suite down for */ }
    }
  }

  get size(): number { return this.byId.size; }
  ids(): string[] { return [...this.byId.keys()]; }
  get(id: string): Fixture | undefined { return this.byId.get(id.toLowerCase()); }

  save(fx: Fixture): void {
    mkdirSync(this.dir, { recursive: true });
    const safe = fx.id.replace(/[^A-Za-z0-9_-]/g, "_");
    writeFileSync(join(this.dir, `${safe}.json`), JSON.stringify(fx, null, 2), "utf8");
    this.byId.set(fx.id.toLowerCase(), fx);
  }

  /**
   * A transport that answers from the fixtures.
   *
   * An unknown ID **throws with the ID named** rather than returning an empty
   * envelope. A mock that silently answers "nothing" for a shape it does not
   * have reproduces the exact failure this whole rebuild is about.
   */
  transport(): Transport {
    return async (_url, xml) => {
      const id = idOf(xml);
      const fx = this.get(id);
      if (!fx) {
        throw new Error(
          `No fixture for request id "${id}". Capture it first — a mock that answers ` +
          `an unknown shape with an empty envelope is indistinguishable from Tally ` +
          `returning nothing, which is the failure this exists to prevent. ` +
          `Have: ${this.ids().join(", ") || "(none)"}`,
        );
      }
      return fx.responseXml;
    };
  }
}

// ── Deliberate damage ─────────────────────────────────────────────────────

/**
 * Mutate a captured response into a shape that has actually broken a parser.
 *
 * Each of these is a real failure, not an invented one. Feeding them to a
 * parser is the cheapest way to find out whether it distinguishes "Tally said
 * nothing" from "I could not read what Tally said".
 */
export type Mutation =
  | "empty-collection"      // the DATA node is there and holds nothing
  | "no-data-node"          // an error-shaped envelope with no DATA at all
  | "lineerror"             // Tally named a problem
  | "exceptions"            // accepted, then refused, with no reason given
  | "truncated"             // the response was cut off mid-object
  | "placeholder-lists"     // entry lists present but empty — the 24 MB pull's shape
  | "cmpinfo-only"          // nothing but the preamble
  | "attributes-stripped"   // tags without attributes, e.g. a report
  | "control-chars";        // Tally's &#4; prefix on values

export function mutate(xml: string, how: Mutation): string {
  switch (how) {
    case "empty-collection":
      return xml.replace(/<COLLECTION>[\s\S]*<\/COLLECTION>/i, "<COLLECTION></COLLECTION>");
    case "no-data-node":
      return xml.replace(/<DATA>[\s\S]*<\/DATA>/i, "");
    case "lineerror":
      return xml.replace(/<DATA>/i, "<DATA><LINEERROR>Ledger 'NOT A LEDGER' does not exist!</LINEERROR>");
    case "exceptions":
      return xml.replace(/<\/IMPORTRESULT>/i, "<EXCEPTIONS>1</EXCEPTIONS></IMPORTRESULT>");
    case "truncated":
      return xml.slice(0, Math.floor(xml.length * 0.6));
    case "placeholder-lists":
      return xml.replace(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi,
        "<ALLLEDGERENTRIES.LIST></ALLLEDGERENTRIES.LIST>");
    case "cmpinfo-only":
      return xml.replace(/<DATA>[\s\S]*<\/DATA>/i, "<DATA><COLLECTION></COLLECTION></DATA>");
    case "attributes-stripped":
      return xml.replace(/<([A-Z][A-Z0-9._]*)\s+[^>]*>/gi, "<$1>");
    case "control-chars":
      return xml.replace(/>([A-Za-z])/g, ">&#4; $1");
  }
}

export const ALL_MUTATIONS: Mutation[] = [
  "empty-collection", "no-data-node", "lineerror", "exceptions",
  "truncated", "placeholder-lists", "cmpinfo-only", "attributes-stripped", "control-chars",
];

export function mutationMeaning(m: Mutation): string {
  switch (m) {
    case "empty-collection": return "Tally answered, and the answer was empty. NOT an error.";
    case "no-data-node": return "An error-shaped envelope. Every convertX() falls into its 'no DATA' branch and returns an empty array — visually identical to an empty collection.";
    case "lineerror": return "Tally named the problem. The transport rejects on this unless rawMode.";
    case "exceptions": return "Accepted, then refused, with no reason. The silent-failure signature.";
    case "truncated": return "Cut off mid-object. A parser must not report a partial read as a complete one.";
    case "placeholder-lists": return "Entry lists present but empty — what a 24 MB voucher pull actually returns.";
    case "cmpinfo-only": return "Nothing but the preamble, whose count tags look like objects.";
    case "attributes-stripped": return "Tags with no attributes, e.g. a report. Broke the <TAG\\s splitter.";
    case "control-chars": return "Tally's &#4; prefix on values.";
  }
}
