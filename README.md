# pi-codeblock-box

Pi extension that renders inline Markdown fenced code blocks as terminal boxes instead of literal backtick fences in the normal Pi conversation view.

## Install

From GitHub:

```bash
pi install git:github.com/de-monkey-v/pi-codeblock-box
```

From a local checkout while developing:

```bash
pi install /home/gyu/dev/pi-extensions/pi-codeblock-box
```

From npm after publishing:

```bash
pi install npm:pi-codeblock-box
```

Then restart Pi or run `/reload`.

## What changes

Before, Pi's inline Markdown renderer displays fenced code blocks like:

````markdown
```text
hello
```
````

This extension patches Pi's `Markdown.prototype.renderToken` at runtime so code blocks render as a box:

```text
╭─ text ─────────────╮
│ hello              │
╰────────────────────╯
```

Syntax highlighting, language labels, Korean/wide characters, and narrow terminal widths are handled using Pi TUI width utilities.


## Configuration

Create `~/.pi/agent/codeblock-box.json` to override label and border colours:

```json
{
  "labelColor": "#1ee9b6",
  "labelColors": {
    "text": "blue"
  },
  "borderColor": "#5f6460"
}
```

Values can be:

- `"theme"` or omitted: use the active Pi theme (`mdCode` for labels, `mdCodeBlockBorder` for borders)
- `"none"`: no explicit colour, use the terminal default
- named colours: `blue`, `cyan`, `green`, `yellow`, `red`, `magenta`, `purple`, `gray`, `white`, `black`
- `"#RRGGBB"` or `"#RGB"`: force a true-colour ANSI foreground colour

You can point to a different config file with `PI_CODEBLOCK_BOX_CONFIG=/path/to/config.json`. New messages pick up config changes automatically; run `/reload` if you want to force already-created Markdown components to rebuild.

### Interactive settings

Open the settings picker from Pi:

```text
/codeblock-settings
```

Direct command forms are also supported:

```text
/codeblock-settings show
/codeblock-settings reset
/codeblock-settings label #ffb71b
/codeblock-settings label text blue
/codeblock-settings label bash #ffb71b
/codeblock-settings border #2aa12b
/codeblock-settings label theme
/codeblock-settings border none
```

## Compatibility

Tested with:

- `@earendil-works/pi-coding-agent` 0.74.0
- `@earendil-works/pi-tui` 0.74.0
- Node.js 24.12.0
- WSL2 Ubuntu 22.04

This extension uses an internal monkey patch because Pi currently exposes `registerMessageRenderer` only for custom messages, not for normal assistant/user Markdown rendering. If Pi changes the internal `Markdown.prototype.renderToken` method, the extension falls back to the default renderer and prints a warning.

## Risk

This affects all Pi inline Markdown rendered through `@earendil-works/pi-tui`'s `Markdown` component: assistant messages, user messages, custom messages, skill messages, compaction summaries, etc.

It does not replace `/preview` from `pi-markdown-preview`; that remains a separate full-document preview tool.
