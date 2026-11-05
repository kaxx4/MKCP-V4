# Migrations

New migrations are NOT added here. They go to the web repo's folder,
`web-dashboard/supabase/migrations/`, numbered from `0105` (decision D-0.1 in the
rebuild plan; the live database already holds migrations numbered `0103` and
`0104`). Every migration since `0090` already landed there, and one home avoids
the number clashes between the two folders (36 numbers appear in both).

This folder holds the older agent-side history: 46 SQL files, `001` to `050`,
with `013`, `014`, `015` and `046` missing. It is kept as a record; do not
renumber or edit these files. Apply nothing to the live database without the
owner's yes, and never trust any migrations folder as the state of the
database: confirm the live object first.
