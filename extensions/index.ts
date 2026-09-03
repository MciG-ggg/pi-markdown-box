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
 * Commands: /markdown-box-settings · /copy-code [N] (copy Nth-most-recent raw code text)
 *           /copy-block (pick from recent) · Shortcut: Ctrl+Shift+Y (copy latest)
 */
import { copyToClipboard, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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

// Raw text of the last boxed code blocks (from the tokens, before box drawing).
const recentCodeBlocks: { lang: string; text: string }[] = [];
const MAX_RECENT = 16;

function recordCodeBlock(lang: string, text: string) {
	recentCodeBlocks.push({ lang, text });
	if (recentCodeBlocks.length > MAX_RECENT) recentCodeBlocks.shift();
}

// Selection labels for /copy-block: newest first, #1 = most recent.
function copyBlockLabels() {
	return [...recentCodeBlocks].reverse().map(
		(b, i) => `#${i + 1} ${b.lang || "code"} · ${b.text.split("\n")[0]}`,
	);
}

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
			if (maybeToken.text) recordCodeBlock(maybeToken.lang ?? "", maybeToken.text);
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

	// Copy raw code-block text captured at render time (no box borders).
	const copyBlock = async (ui: ExtensionUIContext, fromEnd: number) => {
		const block = recentCodeBlocks[recentCodeBlocks.length - fromEnd];
		if (!block) {
			ui.notify("No recent code block to copy");
			return;
		}
		await copyToClipboard(block.text);
		ui.notify(`Copied ${block.lang || "code"} block (${block.text.length} chars)`);
	};

	pi.registerCommand("copy-code", {
		description: "Copy the Nth most recent code block raw text (default 1); /copy-code 2 = second most recent",
		handler: async (args, ctx) => {
			const n = parseInt(args.trim(), 10);
			await copyBlock(ctx.ui, Number.isNaN(n) ? 1 : n);
		},
	});

	pi.registerCommand("copy-block", {
		description: "List recent code blocks (newest first) and copy the one you pick",
		handler: async (_args, ctx) => {
			if (recentCodeBlocks.length === 0) {
				ctx.ui.notify("No recent code block to copy");
				return;
			}
			const labels = copyBlockLabels();
			const pick = await ctx.ui.select("Copy code block", labels);
			if (!pick) return;
			await copyBlock(ctx.ui, labels.indexOf(pick) + 1);
		},
	});

	pi.registerShortcut("ctrl+shift+y", {
		description: "Copy most recent code block raw text",
		handler: (ctx) => copyBlock(ctx.ui, 1),
	});
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

	// Copy ring buffer: capture pushes, eviction at MAX_RECENT, copy-code index math, copy-block ordering
	{
		recentCodeBlocks.length = 0;
		for (let i = 0; i < MAX_RECENT + 3; i++) recordCodeBlock("t", String(i));
		if (recentCodeBlocks.length !== MAX_RECENT)
			fail(`copy-ring: expected ${MAX_RECENT}, got ${recentCodeBlocks.length}`);
		if (recentCodeBlocks[0].text !== "3") fail(`copy-ring: oldest not evicted (got ${recentCodeBlocks[0].text})`);
		if (recentCodeBlocks[recentCodeBlocks.length - 1].text !== String(MAX_RECENT + 2)) fail("copy-ring: newest missing");
		const fromEnd = 2;
		const block = recentCodeBlocks[recentCodeBlocks.length - fromEnd];
		if (block?.text !== String(MAX_RECENT + 1)) fail(`copy-code: fromEnd ${fromEnd} mismatch (got ${block?.text})`);

		// copy-block: newest on top (#1), pick index+1 maps to fromEnd
		const labels = copyBlockLabels();
		if (labels[0] !== `#1 t · ${MAX_RECENT + 2}`) fail(`copy-block: newest not on top (got ${labels[0]})`);
		if (labels[labels.length - 1] !== `#${MAX_RECENT} t · 3`) fail("copy-block: oldest not on bottom");
		const picked = labels[4];
		const viaPick = recentCodeBlocks[recentCodeBlocks.length - (labels.indexOf(picked) + 1)];
		if (viaPick?.text !== String(MAX_RECENT + 2 - 4)) fail("copy-block: pick index mapping off");

		recentCodeBlocks.length = 0;
	}

	console.log("pi-markdown-box self-check passed");
}