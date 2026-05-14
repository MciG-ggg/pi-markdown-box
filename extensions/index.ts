import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type MarkdownLike = {
  theme?: {
    code?: (text: string) => string;
    codeBlock: (text: string) => string;
    codeBlockBorder: (text: string) => string;
    highlightCode?: (code: string, lang?: string) => string[];
  };
};

type CodeToken = {
  type: string;
  text?: string;
  lang?: string;
};

type RenderToken = (token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];

const PATCH_FLAG = Symbol.for("pi-codeblock-box-renderer.patched");
const ORIGINAL = Symbol.for("pi-codeblock-box-renderer.originalRenderToken");

type CodeblockBoxConfig = {
  /** Hex color/name like "#1ee9b6" or "blue", "theme" to use Pi theme, or "none" for terminal default. */
  labelColor?: string;
  /** Per-language label colors. Example: { "text": "blue", "bash": "#ffb71b" }. */
  labelColors?: Record<string, string>;
  /** Hex color/name like "#5f6460" or "gray", "theme" to use Pi theme, or "none" for terminal default. */
  borderColor?: string;
};

let cachedConfigPath: string | undefined;
let cachedConfigMtime = -1;
let cachedConfig: CodeblockBoxConfig = {};
let warnedConfigError = false;

function getConfigPath(): string {
  return process.env.PI_CODEBLOCK_BOX_CONFIG || path.join(os.homedir(), ".pi", "agent", "codeblock-box.json");
}

function getConfig(): CodeblockBoxConfig {
  const configPath = getConfigPath();
  try {
    const stat = fs.statSync(configPath);
    if (cachedConfigPath === configPath && cachedConfigMtime === stat.mtimeMs) return cachedConfig;
    cachedConfigPath = configPath;
    cachedConfigMtime = stat.mtimeMs;
    cachedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as CodeblockBoxConfig;
    warnedConfigError = false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !warnedConfigError) {
      console.warn(`[pi-codeblock-box] Could not read config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
      warnedConfigError = true;
    }
    cachedConfigPath = configPath;
    cachedConfigMtime = -1;
    cachedConfig = {};
  }
  return cachedConfig;
}

function writeConfig(config: CodeblockBoxConfig): string {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}
`, "utf8");
  cachedConfigPath = undefined;
  cachedConfigMtime = -1;
  cachedConfig = {};
  return configPath;
}

function normalizeColorInput(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === "theme" || lower === "none" || lower === "default") return lower === "default" ? "none" : lower;
  if (hexToRgb(value)) return lower in NAMED_COLORS ? lower : value;
  return undefined;
}

function formatConfig(config: CodeblockBoxConfig): string {
  const perLang = config.labelColors && Object.keys(config.labelColors).length > 0
    ? `, labelColors=${JSON.stringify(config.labelColors)}`
    : "";
  return `labelColor=${config.labelColor ?? "theme"}, borderColor=${config.borderColor ?? "theme"}${perLang}`;
}

async function promptColor(ctx: any, field: "labelColor" | "borderColor", current: CodeblockBoxConfig): Promise<CodeblockBoxConfig | undefined> {
  const label = field === "labelColor" ? "Label color" : "Border color";
  const previous = current[field] ?? "theme";
  const value = await ctx.ui.input(`${label} (theme, none, #RRGGBB)`, previous);
  if (value === undefined) return undefined;
  const normalized = normalizeColorInput(String(value));
  if (!normalized) {
    ctx.ui.notify(`Invalid color: ${value}. Use theme, none, #RGB, or #RRGGBB.`, "error");
    return undefined;
  }
  return { ...current, [field]: normalized };
}

function parseCommandArgs(args: string): { field?: "labelColor" | "borderColor"; value?: string; action?: "show" | "reset" } | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  const [first, ...rest] = trimmed.split(/\s+/);
  const key = first.toLowerCase();
  if (key === "show" || key === "status") return { action: "show" };
  if (key === "reset") return { action: "reset" };
  if (key === "label" || key === "labelcolor") return { field: "labelColor", value: rest.join(" ") };
  if (key === "border" || key === "bordercolor" || key === "line") return { field: "borderColor", value: rest.join(" ") };
  return undefined;
}

function registerSettingsCommand(pi: ExtensionAPI) {
  pi.registerCommand("codeblock-settings", {
    description: "Configure code block box label and border colors",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCommandArgs(args ?? "");
      let config = getConfig();

      if (parsed?.action === "show") {
        ctx.ui.notify(`Codeblock box: ${formatConfig(config)} (${getConfigPath()})`, "info");
        return;
      }

      if (parsed?.action === "reset") {
        const configPath = writeConfig({ labelColor: "theme", borderColor: "theme" });
        ctx.ui.notify(`Codeblock box reset to theme colors: ${configPath}`, "info");
        return;
      }

      if (parsed?.field) {
        const rawValue = parsed.value ?? "";
        const parts = rawValue.trim().split(/\s+/).filter(Boolean);
        if (parsed.field === "labelColor" && parts.length >= 2) {
          const lang = parts[0].toLowerCase();
          const normalized = normalizeColorInput(parts.slice(1).join(" "));
          if (!normalized) {
            ctx.ui.notify("Usage: /codeblock-settings label text blue | label #ffb71b | border #2aa12b | show | reset", "error");
            return;
          }
          const configPath = writeConfig({ ...config, labelColors: { ...(config.labelColors ?? {}), [lang]: normalized } });
          ctx.ui.notify(`Saved ${lang} label color: ${normalized} (${configPath})`, "info");
          return;
        }
        const normalized = normalizeColorInput(rawValue);
        if (!normalized) {
          ctx.ui.notify("Usage: /codeblock-settings label text blue | label #ffb71b | border #2aa12b | show | reset", "error");
          return;
        }
        const configPath = writeConfig({ ...config, [parsed.field]: normalized });
        ctx.ui.notify(`Saved codeblock box settings: ${formatConfig(getConfig())} (${configPath})`, "info");
        return;
      }

      const labelColors = config.labelColors ?? {};
      const labelColorSummary = Object.keys(labelColors).length > 0
        ? Object.entries(labelColors).map(([lang, color]) => `${lang}=${color}`).join(", ")
        : "none";

      const choice = await ctx.ui.select("Codeblock box settings", [
        `Default label color: ${config.labelColor ?? "theme"}`,
        `Border color: ${config.borderColor ?? "theme"}`,
        `Language label colors: ${labelColorSummary}`,
        "Add/update language label color",
        "Reset to theme colors",
        "Show config path",
      ]);

      if (!choice) return;
      if (choice.startsWith("Default label color")) {
        const next = await promptColor(ctx, "labelColor", config);
        if (!next) return;
        const configPath = writeConfig(next);
        ctx.ui.notify(`Saved default label color: ${next.labelColor} (${configPath})`, "info");
      } else if (choice.startsWith("Border color")) {
        const next = await promptColor(ctx, "borderColor", config);
        if (!next) return;
        const configPath = writeConfig(next);
        ctx.ui.notify(`Saved border color: ${next.borderColor} (${configPath})`, "info");
      } else if (choice.startsWith("Language label colors")) {
        ctx.ui.notify(`Language label colors: ${labelColorSummary}`, "info");
      } else if (choice.startsWith("Add/update language")) {
        const lang = await ctx.ui.input("Language label to configure (text, bash, ts, python, ...)", "text");
        if (lang === undefined) return;
        const langKey = String(lang).trim().toLowerCase();
        if (!langKey) return;
        const value = await ctx.ui.input(`${langKey} label color (theme, none, blue, #RRGGBB)`, config.labelColors?.[langKey] ?? "blue");
        if (value === undefined) return;
        const normalized = normalizeColorInput(String(value));
        if (!normalized) {
          ctx.ui.notify(`Invalid color: ${value}. Use theme, none, a named color, #RGB, or #RRGGBB.`, "error");
          return;
        }
        const configPath = writeConfig({ ...config, labelColors: { ...(config.labelColors ?? {}), [langKey]: normalized } });
        ctx.ui.notify(`Saved ${langKey} label color: ${normalized} (${configPath})`, "info");
      } else if (choice.startsWith("Reset")) {
        const ok = await ctx.ui.confirm("Reset codeblock colors?", "Use active Pi theme colors for both label and border.");
        if (!ok) return;
        const configPath = writeConfig({ labelColor: "theme", borderColor: "theme" });
        ctx.ui.notify(`Codeblock box reset: ${configPath}`, "info");
      } else {
        ctx.ui.notify(`Config path: ${getConfigPath()}
Current: ${formatConfig(config)}`, "info");
      }
    },
  });
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  red: "#f87171",
  green: "#2aa12b",
  yellow: "#ffb71b",
  blue: "#5ba7ff",
  magenta: "#c084fc",
  purple: "#c084fc",
  cyan: "#1ee9b6",
  gray: "#878b86",
  grey: "#878b86",
  dim: "#5f6460",
  white: "#f6fff5",
};

function hexToRgb(hex: string): [number, number, number] | undefined {
  const trimmed = NAMED_COLORS[hex.trim().toLowerCase()] ?? hex.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1].split("").map((ch) => parseInt(ch + ch, 16));
    return [r, g, b];
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (full) {
    const n = parseInt(full[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return undefined;
}

function colorizeHex(hex: string, text: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return text;
  const [r, g, b] = rgb;
  return `[38;2;${r};${g};${b}m${text}[39m`;
}

function makeStyler(defaultStyle: (text: string) => string, override?: string): (text: string) => string {
  const value = override?.trim();
  if (!value || value === "theme") return defaultStyle;
  if (value === "none" || value === "default") return (text) => text;
  if (!hexToRgb(value)) return defaultStyle;
  return (text) => colorizeHex(value, text);
}

function padAnsi(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function makeBorder(theme: NonNullable<MarkdownLike["theme"]>, left: string, label: string, right: string, width: number, config: CodeblockBoxConfig): string {
  const minWidth = visibleWidth(left) + visibleWidth(right);
  const available = Math.max(0, width - minWidth);
  const safeLabel = label ? truncateToWidth(label, Math.max(0, available - 1), "…") : "";
  const labelPart = safeLabel ? ` ${safeLabel} ` : "";
  const fillWidth = Math.max(0, available - visibleWidth(labelPart));
  const styleBorder = makeStyler(theme.codeBlockBorder, config.borderColor);
  const langKey = label.trim().toLowerCase();
  const labelOverride = (langKey && config.labelColors?.[langKey]) || config.labelColor;
  const styleLabel = makeStyler(theme.code ?? theme.codeBlock, labelOverride);
  return styleBorder(left) + (labelPart ? styleLabel(labelPart) : "") + styleBorder("─".repeat(fillWidth) + right);
}

function renderCodeBox(instance: MarkdownLike, token: CodeToken, width: number, nextTokenType?: string): string[] {
  const theme = instance.theme;
  if (!theme || width < 8) return [];

  const label = token.lang ?? "";
  const innerWidth = Math.max(1, width - 4);
  const rawCode = token.text ?? "";
  const sourceLines = theme.highlightCode
    ? theme.highlightCode(rawCode, token.lang)
    : rawCode.split("\n").map((line) => theme.codeBlock(line));

  const lines: string[] = [];
  const config = getConfig();
  lines.push(makeBorder(theme, "╭─", label, "╮", width, config));

  for (const sourceLine of sourceLines.length ? sourceLines : [""]) {
    const wrapped = wrapTextWithAnsi(sourceLine, innerWidth);
    for (const wrappedLine of wrapped.length ? wrapped : [""]) {
      const padded = padAnsi(wrappedLine, innerWidth);
      const styleBorder = makeStyler(theme.codeBlockBorder, config.borderColor);
      lines.push(styleBorder("│ ") + padded + styleBorder(" │"));
    }
  }

  lines.push(makeBorder(theme, "╰─", "", "╯", width, config));
  if (nextTokenType && nextTokenType !== "space") lines.push("");
  return lines;
}

export default function (pi: ExtensionAPI) {
  registerSettingsCommand(pi);
  const proto = Markdown?.prototype as unknown as Record<PropertyKey, unknown>;
  const current = proto?.renderToken;

  if (typeof current !== "function") {
    console.warn("[pi-codeblock-box] Markdown.prototype.renderToken unavailable; code block box rendering disabled.");
    return;
  }

  const originalRenderToken = typeof proto[ORIGINAL] === "function" ? proto[ORIGINAL] : current;
  proto[ORIGINAL] = originalRenderToken;
  proto.renderToken = function patchedRenderToken(this: MarkdownLike, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown): string[] {
    const original = proto[ORIGINAL] as RenderToken | undefined;
    if (!original) return [];

    const maybeToken = token as CodeToken;
    if (maybeToken?.type === "code") {
      try {
        const boxed = renderCodeBox(this, maybeToken, width, nextTokenType);
        if (boxed.length > 0) return boxed;
      } catch (error) {
        console.warn(`[pi-codeblock-box] Falling back to default code block renderer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return original.call(this, token, width, nextTokenType, styleContext);
  } as RenderToken;
  proto[PATCH_FLAG] = true;
}
