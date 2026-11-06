/**
 * JOB: build a PostgREST `in` list that cannot be broken by the values in it
 * (rebuild task 1-5, S-7 / SEC-9).
 *
 * `.not("item_id", "in", `(${ids.join(",")})`)` put item ids into the filter
 * as they were. An id holding a comma, a bracket or a double quote changes the
 * list: "ZZ TEST HUB (A), 26" becomes two values and a stray bracket, so the
 * orphan delete keeps the wrong rows or removes the wrong ones. PostgREST
 * reads a value in double quotes literally, with a backslash before any
 * double quote or backslash inside it, so every value is quoted that way.
 */
export function postgrestInList(values: readonly string[]): string {
  if (!values.length) throw new Error("refused: an empty in-list would match nothing, which a NOT IN delete turns into everything");
  const quote = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  return "(" + values.map((v) => quote(String(v))).join(",") + ")";
}
