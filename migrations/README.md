# Migrations

New rebuild migrations are NOT added here. They go to the web repo's folder,
`web-dashboard/supabase/migrations/`, numbered from `0103` (decision D-0.1 in the
rebuild plan). Every migration since `0090` already landed there, and one home
avoids the number clashes between the two folders.

This folder holds the older agent-side history (highest file today: `050`). It is
kept as a record; do not renumber or edit these files. Apply nothing to the live
database without the owner's yes, and never trust any migrations folder as the
state of the database: confirm the live object first.
