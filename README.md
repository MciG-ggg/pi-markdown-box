# pi-markdown-box

Pi extension that renders inline Markdown **fenced code blocks** and **tables** as terminal boxes (rounded `╭─╮` / `╰─╯` style) instead of literal backtick fences in the normal Pi conversation view.

Fork of [de-monkey-v/pi-codeblock-box](https://github.com/de-monkey-v/pi-codeblock-box), broadened to cover more Markdown elements. Same monkey-patch technique; same risk profile.

## What changes

Before, Pi's inline Markdown renderer displays fenced code blocks like:

````markdown
```text
hello
```
````

This extension patches Pi's `Markdown.prototype.renderToken` at runtime so code blocks and tables render as boxes:

```text
╭─ text ─────────╮
│ hello          │
╰────────────────╯
```

```text
╭─────┬───────────╮
│ Col │ Note      │
├─────┼───────────┤
│ a   │ long text │
│     │ continues  │
├─────┼───────────┤
│ b   │ short     │
╰─────┴───────────╯
```

Width-aware cell wrapping, CJK-friendly (`wrapTextWithAnsi` + `cjkBreakRegex`), bold header, optional row separators, alignment from `:---` / `---:` / `:---:`.

## Install

From GitHub:

```bash
pi install git:github.com/MciG-ggg/pi-markdown-box
```

From a local checkout while developing:

```bash
pi install /path/to/pi-markdown-box
```

Then restart Pi or run `/reload`.

## Configuration

Create `~/.pi/agent/markdown-box.json` to override label and border colours and toggle row separators:

```ts
{
  "labelColor": "#1ee9b6",
  "labelColors": {
    "text": "blue"
  },
  "borderColor": "#5f6460",
  "tableRowSeparator": true
}
```

Values can be:

- `"theme"` or omitted: use the active Pi theme (`mdCode` for labels, `mdCodeBlockBorder` for borders)
- `"none"`: no explicit colour, use the terminal default
- named colours: `blue`, `cyan`, `green`, `yellow`, `red`, `magenta`, `purple`, `gray`, `white`, `black`
- `"#RRGGBB"` or `"#RGB"`: force a true-colour ANSI foreground colour

`tableRowSeparator` (default `true`): show `├─┼─┤` between data rows. Set `false` for compact tables.

You can point to a different config file with `PI_MARKDOWN_BOX_CONFIG=/path/to/config.json`. New messages pick up config changes automatically; run `/reload` if you want to force already-created Markdown components to rebuild.

### Interactive settings

Open the settings picker from Pi:

```text
/markdown-box-settings
```

Direct command forms:

```text
/markdown-box-settings show
/markdown-box-settings reset
/markdown-box-settings label #ffb71b
/markdown-box-settings label text blue
/markdown-box-settings border #2aa12b
/markdown-box-settings label theme
/markdown-box-settings border none
```

`/codeblock-settings` is not registered — only `/markdown-box-settings`.

## Mermaid

The extension hides ` ```mermaid ` fences (returns `[]` from `renderToken`) and registers a message renderer for `npm:pi-mermaid`'s custom messages, so the ASCII diagram from pi-mermaid's `details.ascii` is shown inside the same `╭─ mermaid ─╮` box style as normal code fences.

For this to work end-to-end:

1. Install `npm:pi-mermaid`.
2. Set `markdown.mermaid` to `"off"` in `~/.pi/agent/settings.json` so Pi's built-in mermaid transformer doesn't also fire.

If either is missing, mermaid fences are hidden silently (no diagram, no crash). The extension warns on load if `markdown.mermaid` is not `"off"`.

## Compatibility

- `@earendil-works/pi-coding-agent` ≥ 0.74.0
- `@earendil-works/pi-tui` ≥ 0.74.0
- Node.js ≥ 24

## Risk

This affects all Pi inline Markdown rendered through `@earendil-works/pi-tui`'s `Markdown` component: assistant messages, user messages, custom messages, skill messages, compaction summaries, etc.

It does not replace `/preview` from `pi-markdown-preview`; that remains a separate full-document preview tool.

## Self-test

```bash
NODE_PATH=/opt/homebrew/lib/node_modules:/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules \
  PI_MARKDOWN_BOX_SELF_TEST=1 bun extensions/index.ts
```

Runs box, table, mermaid, narrow-window, CJK, and fallback cases without needing a Pi session.