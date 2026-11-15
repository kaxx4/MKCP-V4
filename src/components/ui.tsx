/*
 * The agent window's design system, in one file. Every section of the window is built from these parts and nothing else, so two sections can
 * never disagree about a corner, a gap, a chip or a row.
 *
 *   Card    a white card: an icon, a title, one plain-English line under it, optional status chip and actions in the head, tiles in the body.
 *   Tile    a soft block inside a card that holds one chunk (a list of rows, a group of buttons, a set of fields).
 *   Row     one line of a list inside a tile: the status icon, the subject, a meta line, the reason in full, a chip or a button on the right.
 *   Chip    a small tinted status with words: green is good, amber needs a look, red is bad, grey is not known, blue is working.
 *   Note    a tinted sentence with its reason in full, for the thing that needs a person.
 *   Fact    one reading about the pipeline (from status/agentFacts.ts): a label, the chip, and where the reading came from.
 *
 * The geometry (see the card rules in index.css): card corner 20 px with its parts 12 px in, so a tile is 8 px, and a white tile inside a tile is
 * 4 px. Spacing is 4 8 12 16 24. One blue button at most per card. Buttons are 44 px tall everywhere.
 */
import clsx from "clsx";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentFact, FactTone } from "../status/agentFacts";

export type ChipTone = "good" | "warn" | "bad" | "info" | "neutral";

const CHIP: Record<ChipTone, string> = {
  good: "pill pill-good", warn: "pill pill-warn", bad: "pill pill-bad", info: "pill pill-live", neutral: "pill",
};

/** A fact's tone in the chip's words. Unknown is grey, never amber: "not measured" is not the same as "needs a look". */
export const chipToneOf = (t: FactTone): ChipTone => (t === "good" ? "good" : t === "bad" ? "bad" : t === "warn" ? "warn" : "neutral");

export function Chip({ tone = "neutral", children, plain, className }: { tone?: ChipTone; children: ReactNode; plain?: boolean; className?: string }) {
  return <span className={clsx(CHIP[tone], plain && "pill-plain", className)}>{children}</span>;
}

/* ── Card ─────────────────────────────────────────────────────────────────────────────────────── */
interface CardProps {
  icon: LucideIcon;
  title: ReactNode;
  /** One plain-English line under the title. */
  sub?: ReactNode;
  /** The status of the whole card, as a chip beside the title. */
  chip?: ReactNode;
  /** Buttons on the right of the head. Not for a collapsible card, whose head is one button. */
  actions?: ReactNode;
  children: ReactNode;
  /** Makes the head a button that opens and closes the body. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Controlled mode, for the cards whose parent polls only while they are open. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function Card({ icon: Icon, title, sub, chip, actions, children, collapsible, defaultOpen = true, open: openProp, onOpenChange, className }: CardProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = collapsible ? (openProp ?? openState) : true;
  const toggle = () => { const next = !open; setOpenState(next); onOpenChange?.(next); };

  const headText = (
    <span className="block min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="card-title">{title}</span>
        {chip}
      </span>
      {sub && <span className="mt-1 block font-sans text-sm font-normal tracking-normal text-neutral-700">{sub}</span>}
    </span>
  );
  const icon = <Icon size={20} className="mt-0 shrink-0 text-neutral-700" aria-hidden="true" />;

  return (
    <section className={clsx("card", className)}>
      {collapsible ? (
        <h2>
          <button className="card-toggle" onClick={toggle} aria-expanded={open} title={open ? "Hide this section" : "Show this section"}>
            <span className="grid h-6 w-5 shrink-0 place-items-center">{icon}</span>
            {headText}
            <span className="grid h-6 w-5 shrink-0 place-items-center">
              <ChevronDown size={16} className={clsx("text-neutral-600 transition-transform", open && "rotate-180")} aria-hidden="true" />
            </span>
          </button>
        </h2>
      ) : (
        <div className="card-head">
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
            <span className="grid h-6 w-5 shrink-0 place-items-center">{icon}</span>
            <h2 className="min-w-0 flex-1">{headText}</h2>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {open && <div className="card-body">{children}</div>}
    </section>
  );
}

/* ── Tile ─────────────────────────────────────────────────────────────────────────────────────── */
export function Tile({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("tile", className)}>
      {(title || aside) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {title && <h3 className="tile-title">{title}</h3>}
          {aside && <div className="text-xs text-neutral-700">{aside}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** A tile that opens and closes, for the long lists that are not needed at a glance. `badge` is the one small thing worth seeing while it is shut. */
export function Disclosure({ title, badge, defaultOpen = false, children }: { title: ReactNode; badge?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="tile">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-3 text-left"
      >
        <span className="tile-title min-w-0 flex-1">{title}</span>
        {badge}
        <ChevronDown size={16} className={clsx("shrink-0 text-neutral-600 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/* ── Row ──────────────────────────────────────────────────────────────────────────────────────── */
export type RowTone = "neutral" | "success" | "danger" | "warn" | "accent";

const ICON_TONE: Record<RowTone, string> = {
  neutral: "text-neutral-600", success: "text-success", danger: "text-danger", warn: "text-warn", accent: "text-accent",
};

export interface RowProps {
  icon: LucideIcon;
  tone?: RowTone;
  /** The subject of the row: a voucher type, a channel name, a kind of sync. */
  title: ReactNode;
  /** A second subject on the same line (party, company, address). */
  subject?: ReactNode;
  /** When or how much. Small. */
  meta?: ReactNode;
  /** A richer body under the meta line. */
  detail?: ReactNode;
  /** The reason, in full. Never shortened, never behind a click. */
  error?: string | null;
  /** A status chip on the right. */
  chip?: ReactNode;
  /** A button on the right. */
  action?: ReactNode;
  spinning?: boolean;
}

export function Row({ icon: Icon, tone = "neutral", title, subject, meta, detail, error, chip, action, spinning }: RowProps) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2">
      <span className="grid h-5 w-5 shrink-0 place-items-center">
        <Icon size={16} className={clsx(ICON_TONE[tone], spinning && "animate-spin")} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-neutral-900">{title}</span>
          {subject && <span className="text-sm text-neutral-700 wrap-anywhere">{subject}</span>}
        </div>
        {meta && <div className="text-xs text-neutral-700 wrap-anywhere">{meta}</div>}
        {detail && <div className="mt-1 text-sm text-neutral-700 wrap-anywhere">{detail}</div>}
        {error && <p className="note note-bad mt-2 text-xs wrap-anywhere">{error}</p>}
      </div>
      {(chip || action) && <div className={clsx("ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 self-start", !action && "row-chip")}>{chip}{action}</div>}
    </li>
  );
}

export function RowList({ children }: { children: ReactNode }) {
  return <ul className="row-list">{children}</ul>;
}

/** The "nothing here" state. One shape everywhere, so "nothing here" never reads as "still loading". */
export function EmptyNote({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm text-neutral-700">
      <span className="grid h-5 w-5 shrink-0 place-items-center"><Icon size={16} className="text-neutral-600" aria-hidden="true" /></span>
      <span>{children}</span>
    </div>
  );
}

/* ── Note ─────────────────────────────────────────────────────────────────────────────────────── */
const NOTE: Record<Exclude<ChipTone, "neutral">, string> = { good: "note-good", warn: "note-warn", bad: "note-bad", info: "note-info" };

export function Note({ tone, icon: Icon, children, className, role }: { tone: Exclude<ChipTone, "neutral">; icon?: LucideIcon; children: ReactNode; className?: string; role?: string }) {
  return (
    <div className={clsx("note", NOTE[tone], className)} role={role}>
      {Icon && <span className="grid h-5 w-5 shrink-0 place-items-center"><Icon size={16} aria-hidden="true" /></span>}
      <div className="min-w-0 flex-1 space-y-1 wrap-anywhere">{children}</div>
    </div>
  );
}

/* ── Fact ─────────────────────────────────────────────────────────────────────────────────────── */
export function Fact({ fact }: { fact: AgentFact }) {
  return (
    <div className="tile flex flex-col items-start gap-2">
      <span className="text-sm text-neutral-700">{fact.label}</span>
      <Chip tone={chipToneOf(fact.tone)}>{fact.value}</Chip>
      <span className="text-xs text-neutral-700 wrap-anywhere">{fact.sub}</span>
    </div>
  );
}
