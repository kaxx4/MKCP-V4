/**
 * The smallest thing that can run this repo's unit tests.
 *
 * ── Why not vitest ────────────────────────────────────────────────────────
 *
 * `src/engine/__tests__/audit.test.ts` imports from "vitest" and this repo has
 * never had vitest installed — no dependency, no config, and no `test` script
 * in package.json. Fifteen tests over the inventory identity
 * `CLOSING = OPENING + INWARDS − OUTWARDS` have therefore been unrunnable for
 * as long as they have existed, which is worse than having no tests: the file
 * looks like coverage.
 *
 * Installing vitest was tried first. Its current release wants a newer `vite`
 * than this repo pins and npm refuses the tree, and forcing a resolution on the
 * day an installer ships is a poor trade for fifteen assertions.
 *
 * So this provides the three functions the file actually uses. The repo already
 * runs its other tests exactly this way — `scripts/fidelity/test-numbering.ts`
 * and `scripts/test-price-log.ts` are both plain `tsx` scripts with a hand-
 * rolled `is()`. This is that idiom, given the vitest-shaped surface so the
 * test file reads the same as its counterparts in the web repo.
 *
 * It deliberately implements only `toBe` and `toContain` — the two matchers in
 * use. Anything else throws by name rather than silently passing, which is the
 * failure mode a hand-rolled shim has to avoid.
 */

interface Suite { name: string; fn: () => void }

const suites: Suite[] = [];
let currentSuite = "";
let passed = 0;
let failed = 0;
const failures: string[] = [];

export function describe(name: string, fn: () => void): void {
  suites.push({ name, fn });
}

export function it(name: string, fn: () => void): void {
  const label = `${currentSuite} › ${name}`;
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${label}\n      ${(e as Error).message}`);
  }
}

export function expect(actual: unknown) {
  return {
    toBe(want: unknown) {
      if (!Object.is(actual, want)) {
        throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
      }
    },
    toContain(want: unknown) {
      const ok = typeof actual === "string"
        ? actual.includes(String(want))
        : Array.isArray(actual) && actual.includes(want);
      if (!ok) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(want)}`);
    },
    toBeLessThan(want: number) {
      if (!(Number(actual) < want)) throw new Error(`expected ${actual} < ${want}`);
    },
    toBeGreaterThan(want: number) {
      if (!(Number(actual) > want)) throw new Error(`expected ${actual} > ${want}`);
    },
    toBeCloseTo(want: number, digits = 2) {
      if (Math.abs(Number(actual) - want) >= Math.pow(10, -digits) / 2) {
        throw new Error(`expected ${actual} to be close to ${want}`);
      }
    },
    /** Named rather than missing: an unimplemented matcher must fail LOUDLY.
     *  A shim whose unknown matchers resolve to `undefined` turns every test
     *  using one into a silent pass, which is worse than not running at all. */
    get toEqual() { throw new Error("tiny-test: toEqual is not implemented — add it or use toBe"); },
    get toThrow() { throw new Error("tiny-test: toThrow is not implemented — add it"); },
  };
}

/** Run everything collected by the imports above, and report. */
export function run(): void {
  for (const s of suites) {
    currentSuite = s.name;
    s.fn();
  }
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}
