/**
 * pi-markdown-box — boxes Markdown in the TUI: code fences + tables + mermaid routing.
 * Monkey-patches Markdown.prototype.renderToken and registers a message renderer for
 * npm:pi-mermaid's custom messages.
 *
 * Install:
 *   pi install git:github.com/MciG-ggg/pi-markdown-box
 *   (or load directly from ~/.pi/agent/extensions/pi-markdown-box)
 *
 * Config: ~/.pi/agent/markdown-box.json
 * Command: /markdown-box-settings
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { renderCodeBox } from "./codeblock";
import { renderTableBox } from "./table";
import {
	createMermaidMessageRenderer,
	isMermaidCodeToken,
	isPiMermaidInstalled,
	readBuiltinMermaidMode,
} from "./mermaid";
import { registerSettingsCommand } from "./settings";
import type { MarkdownLike } from "./theme";

const PATCH_FLAG = Symbol.for("pi-markdown-box-renderer.patched");
const ORIGINAL = Symbol.for("pi-markdown-box-renderer.originalRenderToken");

type RenderToken = (token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];

export default function (pi: ExtensionAPI) {
	registerSettingsCommand(pi);

	const proto = Markdown?.prototype as unknown as Record<PropertyKey, unknown>;
	const current = proto?.renderToken;

	if (typeof current !== "function") {
		console.warn("[pi-markdown-box] Markdown.prototype.renderToken unavailable; box rendering disabled.");
		return;
	}

	const originalRenderToken = typeof proto[ORIGINAL] === "function" ? proto[ORIGINAL] : current;
	proto[ORIGINAL] = originalRenderToken;
	proto.renderToken = function patchedRenderToken(
		this: MarkdownLike,
		token: unknown,
		width: number,
		nextTokenType?: string,
		styleContext?: unknown,
	): string[] {
		const original = proto[ORIGINAL] as RenderToken | undefined;
		if (!original) return [];

		const maybeToken = token as { type?: string; lang?: string; text?: string };

		if (maybeToken?.type === "code") {
			if (isMermaidCodeToken(maybeToken) && isPiMermaidInstalled()) return []; // defer to npm:pi-mermaid
			try {
				const boxed = renderCodeBox(this, maybeToken as { type: string; text?: string; lang?: string }, width, nextTokenType);
				if (boxed.length > 0) return boxed;
			} catch (error) {
				console.warn(`[pi-markdown-box] Falling back to default code block renderer: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (maybeToken?.type === "table") {
			try {
				const boxed = renderTableBox(this, maybeToken as Parameters<typeof renderTableBox>[1], width, nextTokenType);
				if (boxed.length > 0) return boxed;
			} catch (error) {
				console.warn(`[pi-markdown-box] Falling back to default table renderer: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		return original.call(this, token, width, nextTokenType, styleContext);
	} as RenderToken;
	proto[PATCH_FLAG] = true;

	pi.registerMessageRenderer("pi-mermaid", createMermaidMessageRenderer());

	const mermaidMode = readBuiltinMermaidMode();
	if (isPiMermaidInstalled() && mermaidMode !== "off") {
		console.warn(
			`[pi-markdown-box] Built-in markdown.mermaid is "${mermaidMode}". Set it to "off" so only npm:pi-mermaid renders diagrams (otherwise the built-in and pi-mermaid both fire).`,
		);
	}
}

// Self-test: PI_MARKDOWN_BOX_SELF_TEST=1 bun extensions/index.ts
if (process.env.PI_MARKDOWN_BOX_SELF_TEST === "1") {
	const mockTheme = {
		codeBlockBorder: (s: string) => `|${s}|`,
		codeBlock: (s: string) => `*${s}*`,
		code: (s: string) => `<${s}>`,
		bold: (s: string) => `**${s}**`,
	};
	const mockInstance: MarkdownLike = {
		theme: mockTheme,
		renderInlineTokens: (tokens: any) =>
			(Array.isArray(tokens) ? tokens : [tokens]).map((t: any) => t?.text ?? ""),
	};

	const fail = (msg: string) => {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	};

	// Code block
	{
		const out = renderCodeBox(mockInstance, { type: "code", lang: "python", text: "x = 1" }, 30);
		if (out.length < 3) fail(`codeblock: expected >=3 lines, got ${out.length}`);
		if (!out[0].includes("python")) fail("codeblock: missing lang label");
		if (!out[0].startsWith("|╭─")) fail("codeblock: missing ╭ top-left");
		if (!out[out.length - 1].startsWith("|╰─")) fail("codeblock: missing ╰ bottom-left");
	}

	// Code block too narrow
	{
		const out = renderCodeBox(mockInstance, { type: "code", lang: "py", text: "x" }, 4);
		if (out.length !== 0) fail(`codeblock-narrow: expected [], got ${out.length}`);
	}

	// Mermaid code fence: renders normally unless npm:pi-mermaid is installed (then swallowed)
	{
		const out = renderCodeBox(mockInstance, { type: "code", lang: "mermaid", text: "graph TD" }, 60);
		// Without npm:pi-mermaid in settings.json (this user's setup), the fence renders normally.
		if (out.length < 3) fail(`mermaid-render: expected normal box render, got ${out.length} lines`);
		if (!out[0].includes("mermaid")) fail("mermaid-render: missing mermaid label");
	}

	// Table: basic
	{
		const token = {
			type: "table",
			header: [{ text: "A" }, { text: "BB" }],
			align: ["left", "right"] as const,
			rows: [
				[{ text: "long cell one" }, { text: "x" }],
				[{ text: "short" }, { text: "longer cell two" }],
			],
		} as Parameters<typeof renderTableBox>[1];
		const out = renderTableBox(mockInstance, token, 30);
		if (out.length < 4) fail(`table-basic: expected >=4 lines (top+header+sep+row+sep+row+bottom), got ${out.length}`);
		if (!out[0].startsWith("|╭")) fail("table-basic: missing ╭ top-left");
		if (!out[out.length - 1].startsWith("|╰")) fail("table-basic: missing ╰ bottom-left");
		if (!out.some((l) => l.includes("├"))) fail("table-basic: missing ├ separator");
	}

	// Table: narrow window forces wrap
	{
		const token = {
			type: "table",
			header: [{ text: "Col" }],
			align: ["left"] as const,
			rows: [[{ text: "This is a long sentence that should wrap on a narrow terminal." }]],
		} as Parameters<typeof renderTableBox>[1];
		const out = renderTableBox(mockInstance, token, 20);
		if (out.length < 5) fail(`table-narrow: expected wrap to >=5 lines, got ${out.length}`);
		const dataLines = out.filter((l) => l.includes("│")).slice(2); // skip top, header, sep
		if (dataLines.length < 2) fail("table-narrow: expected wrapped cell on multiple lines");
	}

	// Table: too narrow falls back to raw
	{
		const token = {
			type: "table",
			header: [{ text: "A" }],
			align: ["left"] as const,
			rows: [[{ text: "x" }]],
			raw: "|A|\n|---|\n|x|",
		} as Parameters<typeof renderTableBox>[1];
		const out = renderTableBox(mockInstance, token, 8);
		if (out.length === 0) fail("table-fallback: expected non-empty fallback");
		if (out.some((l) => l.includes("╭") || l.includes("│"))) fail("table-fallback: should not draw box chars");
	}

	// Table: CJK content
	{
		const token = {
			type: "table",
			header: [{ text: "组件" }],
			align: ["left"] as const,
			rows: [[{ text: "为每个专家构建能力签名" }]],
		} as Parameters<typeof renderTableBox>[1];
		const out = renderTableBox(mockInstance, token, 30);
		if (out.length < 4) fail(`table-cjk: expected >=4 lines, got ${out.length}`);
	}

	// Table: border alignment regression (mock theme wraps border chars individually,
// so widths can't be compared directly. Just verify all expected lines are produced.)
	{
		const token = {
			type: "table",
			header: [{ text: "A" }, { text: "B" }, { text: "C" }],
			align: ["left", "left", "left"] as const,
			rows: [[{ text: "x" }, { text: "y" }, { text: "z" }]],
		} as Parameters<typeof renderTableBox>[1];
		const out = renderTableBox(mockInstance, token, 30);
		// top + header + separator + row + bottom = 5 lines
		if (out.length !== 5) fail(`table-align: expected 5 lines, got ${out.length}`);
		if (!out[0].includes("╭")) fail("table-align: top border missing ╭");
		if (!out[2].includes("├")) fail("table-align: separator missing ├");
		if (!out[4].includes("╰")) fail("table-align: bottom border missing ╰");
		// The fix added ─ between cells: separator should have at least one ┬
		if (!out[2].includes("┼")) fail("table-align: separator missing ┼ (regression: borderOverhead-style join not applied)");
	}

	console.log("pi-markdown-box self-check passed");
}