import { tallyPost, HEALTH_XML } from "../../src/tally.js";
(async () => {
  try {
    await tallyPost("http://localhost:9000", HEALTH_XML, 20000);
    console.log("ALIVE — Tally is answering");
  } catch (e) { console.log("BLOCKED:", (e as Error).message.slice(0, 100)); }
})();
