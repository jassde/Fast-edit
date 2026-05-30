# Product

## Register

product

## Users

Casual general users who occasionally need to trim a video file — not professional editors, but not afraid of a capable tool either. They arrive with a file, want to mark one or a few segments, and export without configuration overhead. The secondary workflow is download-then-edit: yt-dlp pulls a clip, the user marks it up and exports. Context is typically a personal machine, a single task, low time investment expected.

## Product Purpose

A focused desktop trimming tool built on Tauri v2 + libmpv. Open a video, mark segments on a timeline, export precise cuts via ffmpeg (copy or re-encode). Speed from open to export is the core value. yt-dlp integration provides a second entry point for users who are sourcing footage online. Intentionally narrow scope — no compositing, no effects, no timeline tracks.

## Brand Personality

Modern, sleek, and quietly confident. Feels like it was made by someone with taste. No decoration for its own sake; every UI decision has a reason. References: Linear (tight geometry, purposeful color, fast) and Claude Desktop (polished depth, warm dark, slightly elevated from developer-tool aesthetic).

## Anti-references

- Generic SaaS dark mode: blue-tinted neutrals, Tailwind-samey cards, forgettable color choices, looks like every other tool shipped in 2022–2024.
- Consumer video editors (iMovie, Clipchamp): oversized controls, big friendly buttons, no density — undersells the tool's actual capability.

## Design Principles

1. **Frictionless entry** — casual users should be from file-open to first export in under a minute with zero documentation.
2. **Video first, chrome second** — the video panel is the product; toolbar, timeline, and controls recede into the background until needed.
3. **Warm dark, not cold dark** — the warm-tinted neutral palette (hue ~25) is a deliberate choice that separates this from generic developer tooling; extend it, never replace with blue-shifted grays.
4. **Precision without ceremony** — frame-step, HW encoder selection, multi-segment export are present but never pushed on casual users; they surface through natural exploration.
5. **Restraint as craft** — every element earns its place. Additions require a clear user need; decoration without function is always wrong.

## Accessibility & Inclusion

No formal WCAG target. Apply reasonable contrast as good practice — primary text should be clearly legible, muted/secondary text should still be distinguishable. Keyboard navigation for all primary workflows (already in place via useKeyboard).
