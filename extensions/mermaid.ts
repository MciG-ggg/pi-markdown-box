/**
 * Mermaid routing — hides ```mermaid fences (so npm:pi-mermaid owns the diagram)
 * and registers a message renderer that boxes pi-mermaid ASCII diagrams in our style.
 * Gracefully no-ops if pi-mermaid isn't installed or markdown.mermaid != "off".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { getConfig, makeStyler, padAnsi, type MarkdownLike, type MarkdownBoxConfig } from "./theme";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

/** Match pi's built-in mermaid token check so we never steal ```mermaid fences. */
export function isMermaidCodeToken(token: { type?: string; lang?: string }): boolean {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

export function builtinMermaidMode(raw?: string): "off" | "final" | "streaming" {
	return raw === "off" || raw === "final" ? raw : "streaming";
}

export function readBuiltinMermaidMode(): "off" | "final" | "streaming" {
	try {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as { markdown?: { mermaid?: string } };
		return builtinMermaidMode(settings.markdown?.mermaid);
	} catch {
		return "streaming";
	}
}

export function isPiMermaidInstalled(): boolean {
	try {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as { packages?: string[] };
		return (settings.packages ?? []).includes("npm:pi-mermaid");
	} catch {
		return false;
	}
}

function makeBorder(
	theme: NonNullable<MarkdownLike["theme"]>,
	left: string,
	label: string,
	right: string,
	width: number,
	config: MarkdownBoxConfig,
): string {
	const minWidth = visibleWidth(left) + visibleWidth(right);
	const available = Math.max(0, width - minWidth);
	const safeLabel = label ? truncateToWidth(label, Math.max(0, available - 1), "…") : "";
	const labelPart = safeLabel ? ` ${safeLabel} ` : "";
	const fillWidth = Math.max(0, available - visibleWidth(labelPart));
	const styleBorder = makeStyler(theme.codeBlockBorder, config.borderColor);
	const styleLabel = makeStyler(theme.code ?? theme.codeBlock, config.labelColor);
	return styleBorder(left) + (labelPart ? styleLabel(labelPart) : "") + styleBorder("─".repeat(fillWidth) + right);
}

export function renderMermaidBox(
	instance: MarkdownLike,
	lines: string[],
	width: number,
	label = "mermaid",
): string[] {
	const theme = instance.theme;
	if (!theme || width < 8) return lines;
	const innerWidth = Math.max(1, width - 4);
	const config = getConfig();
	const boxed: string[] = [makeBorder(theme, "╭─", label, "╮", width, config)];
	const styleBorder = makeStyler(theme.codeBlockBorder, config.borderColor);
	for (const line of lines.length ? lines : [""]) {
		const clipped = truncateToWidth(line, innerWidth, "");
		boxed.push(styleBorder("│ ") + padAnsi(clipped, innerWidth) + styleBorder(" │"));
	}
	boxed.push(makeBorder(theme, "╰─", "", "╯", width, config));
	return boxed;
}

/** Wraps the ASCII from npm:pi-mermaid (details.ascii) in our box style. */
export function createMermaidMessageRenderer(): MessageRenderer<any> {
	return (message, _options, _theme) => ({
		render: (width: number) => {
			const ascii = message.details?.ascii ?? "";
			const instance: MarkdownLike = { theme: { codeBlockBorder: (s: string) => s, codeBlock: (s: string) => s, code: (s: string) => s } };
			const lines = ascii ? ascii.split(/\r?\n/) : ["[no diagram]"];
			return renderMermaidBox(instance, lines, Math.max(1, width));
		},
		invalidate: () => {},
	});
}