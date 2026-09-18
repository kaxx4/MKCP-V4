/**
 * The agent repo's unit tests. `npm run test:engine`.
 *
 * Imports each test file (which registers its suites) and then runs them.
 */
import "../src/engine/__tests__/audit.test.js";
import { run } from "./tiny-test.js";
run();
