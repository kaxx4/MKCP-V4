# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Nicknamed **sync agent** in conversation with the user (companion repo: [MKCP MOB2](../MKCP%20MOB2/CLAUDE.md), nicknamed **web app**).

## What this repo is

MK Cycles Electron desktop app that syncs a bicycle-parts distribution business's
TallyPrime data to Supabase, and vice versa. The web app (MKCP MOB2) reads/writes
the same Supabase project but does not talk to TallyPrime directly — this repo is
the sync boundary between Tally and Supabase.
