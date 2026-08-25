/**
 * Code block boxing — wraps fenced code in ╭─lang─╮ / ╰─╯ with ANSI styling.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getConfig, makeStyler, padAnsi, type MarkdownBoxConfig, type MarkdownLike } from "./theme";
import { isMermaidCodeToken } from "./mermaid";

type CodeToken = {
	type: string;
	text?: string;
	lang?: string;
};

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
	const langKey = label.trim().toLowerCase();
	const labelOverride = (langKey && config.labelColors?.[langKey]) || config.labelColor;
	const styleLabel = makeStyler(theme.code ?? theme.codeBlock, labelOverride);
	return styleBorder(left) + (labelPart ? styleLabel(labelPart) : "") + styleBorder("─".repeat(fillWidth) + right);
}

export function renderCodeBox(
	instance: MarkdownLike,
	token: CodeToken,
	width: number,
	nextTokenType?: string,
): string[] {
	if (isMermaidCodeToken(token)) return []; // defer to npm:pi-mermaid
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