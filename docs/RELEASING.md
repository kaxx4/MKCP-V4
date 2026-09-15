# Releasing the sync agent (over-the-air)

Installed copies check GitHub Releases on `kaxx4/MKCP-V4` 30 seconds after
launch and every six hours, download in the background, and install **on the
next ordinary quit** — never mid-session. See `public/autoUpdate.js`.

## The one-time thing that made this possible

The installer used to bundle `server/.env` — the live Supabase service-role key,
which bypasses RLS on every table. **`kaxx4/MKCP-V4` is a public repository**, so
publishing that artifact would have put the key on the open internet.

It is no longer bundled (`electron-builder.json5` → `extraResources` → `filter`).
`loadPackagedEnv()` in `public/electron.js` already preferred
`<userData>/.env`, so nothing changed for a machine that has one.

**Every machine now needs its own credentials, once:**

```
%APPDATA%\mkcycles-dashboard-electron\.env
```

**Not** `%APPDATA%\MK Cycles Dashboard\.env`, however much it looks like it
should be. Electron builds `userData` from package.json's `name`, not from
`productName` — so the folder is named after the package while everything the
operator sees (Programs, Start menu, window title) says "MK Cycles Dashboard".
This was got wrong on the first machine provisioned: the agent came up with the
push drain disabled and a panel telling the operator to edit a `server/.env`
that no longer ships.

`loadPackagedEnv()` now accepts the product-named folder too and logs which path
it actually read, so a wrong guess degrades to a warning that names both.

Copy `server/.env` there by hand (USB, not email). Updates never touch it. A
machine without it starts, serves Tally locally, and self-disables its
Supabase features with a warning in the log — it does not silently run on a key
that arrived by download.

## Cutting a release

1. **Bump the version.** `package.json` → `version`. Nothing else triggers an
   update: a client compares its own version to `latest.yml`, so republishing
   the same number reaches nobody and looks exactly like "you are up to date".

2. **Build, without publishing:**

   ```bash
   npm run build:prod
   ```

   Produces `release2/MK Cycles Dashboard Setup <version>.exe` **and**
   `release2/latest.yml`. This never uploads — `--publish never` is passed
   explicitly, because building and releasing are different decisions.

3. **Publish**, with a GitHub token that can write releases on `kaxx4/MKCP-V4`:

   ```bash
   MKCP_PUBLISH=always GH_TOKEN=<token> npm run release
   ```

   `MKCP_PUBLISH=always` makes the SAME build upload itself. It is not a second
   electron-builder run, deliberately: `build-prod.js` prunes the server's
   dev-dependencies before packaging and restores them afterwards, so a build
   that ran after that restore would package ~100 MB of `typescript` and friends
   and upload an artifact nobody had tested.

   Without the variable, `npm run release` is just a build — same as
   `build:prod`. Uploading is never the default.

## The way this fails silently

**A release published without `latest.yml` is invisible.** electron-updater reads
that file, not the release's asset list — so clients keep reporting "current"
against a version that has been out for weeks, and nobody sees an error. If you
ever upload assets by hand, upload `latest.yml` too.

The second way is the version: two builds with the same number are the same
build as far as every client is concerned.

## What the operator sees

A chip in the agent's header (`UpdateChip` in `src/AgentStatus.tsx`). It is
deliberately quiet — nothing at all while current or checking — and only speaks
up for the two states worth interrupting for:

| State | Chip |
|---|---|
| downloading | `Update 42%` |
| ready | `v1.4.2 ready` — installs on next close |
| error | `Update check failed`, with the reason in the tooltip |

Errors are named rather than swallowed. The two common causes — no network, and
a release missing its `latest.yml` — look identical from the UI unless the
reason is carried through.

## Why it does not restart itself

This process holds Tally's single-threaded XML port and drains the push queue.
`autoInstallOnAppQuit` is on and `quitAndInstall` is never called: quitting
mid-push would abandon a voucher the queue believes is in flight, and the
read-back that proves a voucher landed would never run.

## Migrating the machines you already have

An installed **1.4.0** has no updater, so it cannot pull 1.4.1 by itself. Install
1.4.1 by hand once per machine; from then on releases arrive over the air.
Remember the `.env` step above — 1.4.0 was running on the bundled copy.
