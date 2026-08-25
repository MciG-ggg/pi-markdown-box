/**
 * Shared styling + config for pi-markdown-box.
 * Colors, padding, config loading. No instance state.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NAMED_COLORS: Record<string, string> = {
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

export function hexToRgb(hex: string): [number, number, number] | undefined {
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

export function colorizeHex(hex: string, text: string): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return text;
	const [r, g, b] = rgb;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function normalizeColorInput(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	const lower = value.toLowerCase();
	if (lower === "theme" || lower === "none" || lower === "default") return lower === "default" ? "none" : lower;
	if (hexToRgb(value)) return lower in NAMED_COLORS ? lower : value;
	return undefined;
}

export function makeStyler(
	defaultStyle: (text: string) => string,
	override?: string,
): (text: string) => string {
	const value = override?.trim();
	if (!value || value === "theme") return defaultStyle;
	if (value === "none" || value === "default") return (text) => text;
	if (!hexToRgb(value)) return defaultStyle;
	return (text) => colorizeHex(value, text);
}

export function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Minimal Markdown-instance shape. Real Markdown has more; we only use these. */
export type MarkdownLike = {
	theme?: {
		code?: (text: string) => string;
		codeBlock: (text: string) => string;
		codeBlockBorder: (text: string) => string;
		bold?: (text: string) => string;
		highlightCode?: (code: string, lang?: string) => string[];
	};
	/** Private on Markdown but exposed at runtime; optional for tests with mocks. */
	renderInlineTokens?: (tokens: unknown, styleContext?: unknown) => string[];
};

export type MarkdownBoxConfig = {
	/** Color for code block labels and table headers: "theme" / "none" / named / #RRGGBB. */
	labelColor?: string;
	/** Per-language label colors. { "text": "blue", "bash": "#ffb71b" }. */
	labelColors?: Record<string, string>;
	/** Border color: "theme" / "none" / named / #RRGGBB. */
	borderColor?: string;
	/** Show row separator between data rows. Default true. */
	tableRowSeparator?: boolean;
};

let cachedConfigPath: string | undefined;
let cachedConfigMtime = -1;
let cachedConfig: MarkdownBoxConfig = {};
let warnedConfigError = false;

export function getConfigPath(): string {
	return process.env.PI_MARKDOWN_BOX_CONFIG || path.join(os.homedir(), ".pi", "agent", "markdown-box.json");
}

export function getConfig(): MarkdownBoxConfig {
	const configPath = getConfigPath();
	try {
		const stat = fs.statSync(configPath);
		if (cachedConfigPath === configPath && cachedConfigMtime === stat.mtimeMs) return cachedConfig;
		cachedConfigPath = configPath;
		cachedConfigMtime = stat.mtimeMs;
		cachedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as MarkdownBoxConfig;
		warnedConfigError = false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !warnedConfigError) {
			console.warn(`[pi-markdown-box] Could not read config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
			warnedConfigError = true;
		}
		cachedConfigPath = configPath;
		cachedConfigMtime = -1;
		cachedConfig = {};
	}
	return cachedConfig;
}

export function writeConfig(config: MarkdownBoxConfig): string {
	const configPath = getConfigPath();
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	cachedConfigPath = undefined;
	cachedConfigMtime = -1;
	cachedConfig = {};
	return configPath;
}

export function formatConfig(config: MarkdownBoxConfig): string {
	const parts: string[] = [];
	parts.push(`labelColor=${config.labelColor ?? "theme"}`);
	parts.push(`borderColor=${config.borderColor ?? "theme"}`);
	if (config.labelColors && Object.keys(config.labelColors).length > 0) {
		parts.push(`labelColors=${JSON.stringify(config.labelColors)}`);
	}
	if (config.tableRowSeparator !== undefined) {
		parts.push(`tableRowSeparator=${config.tableRowSeparator}`);
	}
	return parts.join(", ");
}