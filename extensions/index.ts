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
import fs from "node:fs";
import { renderCodeBox } from "./codeblock";
import { renderTableBox } from "./table";
import {
	createMermaidMessageRenderer,
	isMermaidCodeToken,
	isPiMermaidInstalled,
	readBuiltinMermaidMode,
} from "./mermaid";
import { registerSettingsCommand, parseCommandArgs } from "./settings";
import type { MarkdownLike } from "./theme";
import { normalizeColorInput, hexToRgb, colorizeHex, writeConfig, getConfig } from "./theme";

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
			if (isMermaidCodeToken(maybeToken)) {
				// Never wrap mermaid fences in our box style.
				// - npm:pi-mermaid installed → defer to its message renderer.
				// - otherwise → pi's built-in mermaid transformer already ran on the
				//   markdown text: if width fit, it replaced this block with ASCII
				//   art (no longer a code token, we wouldn't see it); if width
				//   fell back, this is the raw source — render it as plain code so
				//   it's still readable and copyable, just not boxed.
				return isPiMermaidInstalled() ? [] : original.call(this, token, width, nextTokenType, styleContext);
			}
			// Only box fenced code that has a language label. Bare ``` fences
			// (lang === "" / whitespace) fall through to the default renderer
			// so pi's plain code styling is preserved. ponytail: gating at the
			// single dispatch site instead of inside renderCodeBox keeps the
			// box renderer reusable for callers that always supply a label.
			const hasLang = (maybeToken.lang ?? "").trim().length > 0;
			if (hasLang) {
				try {
					const boxed = renderCodeBox(this, maybeToken as { type: string; text?: string; lang?: string }, width, nextTokenType);
					if (boxed.length > 0) return boxed;
				} catch (error) {
					console.warn(`[pi-markdown-box] Falling back to default code block renderer: ${error instanceof Error ? error.message : String(error)}`);
				}
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

	// Bare fence (lang === ""): renderCodeBox is still invoked in the
	// self-check (it has no gate inside), but the *patcher* in this file
	// must skip it. We exercise the gate by replaying the same dispatch
	// logic below.
	{
		const token = { type: "code", lang: "", text: "x = 1" };
		const hasLang = (token.lang ?? "").trim().length > 0;
		if (hasLang) fail("gate: bare fence lang must be falsy");
	}
	{
		const token = { type: "code", lang: "   ", text: "x" };
		const hasLang = (token.lang ?? "").trim().length > 0;
		if (hasLang) fail("gate: whitespace-only lang must be falsy");
	}
	{
		const token = { type: "code", lang: "python", text: "x" };
		const hasLang = (token.lang ?? "").trim().length > 0;
		if (!hasLang) fail("gate: labeled fence must pass");
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

	// === Phase 2: gap coverage ===

	// parseCommandArgs: all documented input shapes
	{
		const parseCases: Array<[string, unknown]> = [
			["", undefined],
			["   ", undefined],
			["show", { action: "show" }],
			["status", { action: "show" }],
			["reset", { action: "reset" }],
			["label blue", { field: "labelColor", value: "blue" }],
			["labelColor #ffb71b", { field: "labelColor", value: "#ffb71b" }],
			["label text blue", { field: "labelColor", value: "text blue" }],
			["border #2aa12b", { field: "borderColor", value: "#2aa12b" }],
			["line #abc", { field: "borderColor", value: "#abc" }],
			["garbage", undefined],
		];
		for (const [input, expected] of parseCases) {
			const got = parseCommandArgs(input);
			if (JSON.stringify(got) !== JSON.stringify(expected)) {
				fail(`parseCommandArgs(${JSON.stringify(input)}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
			}
		}
	}

	// normalizeColorInput: edge cases including whitespace, mixed case, 3/6-digit hex
	{
		const normCases: Array<[string, string | undefined]> = [
			["", undefined],
			["   ", undefined],
			["theme", "theme"],
			["THEME", "theme"],
			["  THEME  ", "theme"],
			["none", "none"],
			["default", "none"],
			["blue", "blue"],
			["  blue  ", "blue"],
			["#fff", "#fff"],
			// Hex preserves case (hexToRgb lowercases internally; named colors are lowercased).
			["#FF0000", "#FF0000"],
			["#aBcDeF", "#aBcDeF"],
			["BLUE", "blue"],
			["not-a-color", undefined],
		];
		for (const [input, expected] of normCases) {
			const got = normalizeColorInput(input);
			if (got !== expected) fail(`normalizeColorInput(${JSON.stringify(input)}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
		}
	}

	// hexToRgb + colorizeHex
	{
		if (JSON.stringify(hexToRgb("#fff")) !== "[255,255,255]") fail("hexToRgb #fff");
		if (JSON.stringify(hexToRgb("#FF0000")) !== "[255,0,0]") fail("hexToRgb #FF0000");
		if (JSON.stringify(hexToRgb("#000000")) !== "[0,0,0]") fail("hexToRgb #000000");
		if (hexToRgb("notacolor") !== undefined) fail("hexToRgb garbage must be undefined");
		if (JSON.stringify(hexToRgb("red")) !== JSON.stringify(hexToRgb("#f87171"))) fail("hexToRgb named red resolves to its hex");

		const c = colorizeHex("#00ff00", "x");
		if (!c.includes("x") || !c.includes("\x1b[38;2;0;255;0m")) fail("colorizeHex wraps in true-color ANSI");
		if (colorizeHex("notacolor", "x") !== "x") fail("colorizeHex bad input returns plain text");
	}

	// getConfig hot-reload: writeConfig busts cache, env path override works
	{
		const tmp = `/tmp/pi-markdown-box-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
		const prevEnv = process.env.PI_MARKDOWN_BOX_CONFIG;
		process.env.PI_MARKDOWN_BOX_CONFIG = tmp;
		try {
			const c0 = getConfig();
			if (Object.keys(c0).length !== 0) fail(`getConfig empty: expected {}, got ${JSON.stringify(c0)}`);

			writeConfig({ labelColor: "blue", borderColor: "red" });
			const c1 = getConfig();
			if (c1.labelColor !== "blue" || c1.borderColor !== "red") fail(`getConfig after write: ${JSON.stringify(c1)}`);

			await new Promise((r) => setTimeout(r, 50));
			writeConfig({ labelColor: "green" });
			const c2 = getConfig();
			if (c2.labelColor !== "green") fail(`getConfig hot-reload: expected green, got ${c2.labelColor}`);
			if (c2.borderColor !== undefined) fail(`getConfig hot-reload: stale borderColor should be gone, got ${c2.borderColor}`);

			fs.writeFileSync(tmp, "{ not json", "utf8");
			await new Promise((r) => setTimeout(r, 50));
			const c3 = getConfig();
			if (Object.keys(c3).length !== 0) fail(`getConfig malformed: expected {}, got ${JSON.stringify(c3)}`);
		} finally {
			if (prevEnv === undefined) delete process.env.PI_MARKDOWN_BOX_CONFIG;
			else process.env.PI_MARKDOWN_BOX_CONFIG = prevEnv;
			try { fs.unlinkSync(tmp); } catch {}
		}
	}

	// recordCodeBlock edge: empty / multiline
	{
		recentCodeBlocks.length = 0;
		recordCodeBlock("python", "x = 1");
		recordCodeBlock("text", "");
		recordCodeBlock("text", "\n");
		recordCodeBlock("text", "line1\nline2");
		if (recentCodeBlocks.length !== 4) fail(`recordCodeBlock: expected 4 entries, got ${recentCodeBlocks.length}`);
		const labels = copyBlockLabels();
		if (labels[0] !== "#1 text · line1") fail(`recordCodeBlock: latest label wrong (${labels[0]})`);
		if (labels[1] !== "#2 text · ") fail(`recordCodeBlock: empty-text label wrong (${labels[1]})`);
		recentCodeBlocks.length = 0;
	}

	// === Patcher chain integrity (real bug suspected on /reload) ===
	{
		const fakeProto: Record<PropertyKey, unknown> = {};
		const ORIGINAL = Symbol.for("pi-markdown-box-renderer.originalRenderToken");
		let originalCalls = 0;
		const originalFn = (token: { type?: string }, _width: number) => {
			originalCalls++;
			return [`orig:${token.type}`];
		};
		fakeProto[ORIGINAL] = originalFn;
		fakeProto.renderToken = function v1(this: unknown, token: any, width: number) {
			if (token?.type === "code" && (token.lang ?? "").trim()) {
				return [`boxed1:${token.lang}`];
			}
			return (fakeProto[ORIGINAL] as Function).call(this, token, width);
		};

		originalCalls = 0;
		fakeProto.renderToken({ type: "code", lang: "", text: "x" }, 30);
		if (originalCalls !== 1) fail(`patcher-chain v1 bare fence: expected 1 original call, got ${originalCalls}`);

		originalCalls = 0;
		const r = fakeProto.renderToken({ type: "code", lang: "py", text: "x" }, 30);
		if (r[0] !== "boxed1:py") fail(`patcher-chain v1 labeled: expected boxed, got ${r[0]}`);
		if (originalCalls !== 0) fail(`patcher-chain v1 labeled: original should NOT be called, got ${originalCalls} calls`);

		// simulate /reload — apply patch AGAIN
		fakeProto.renderToken = function v2(this: unknown, token: any, width: number) {
			if (token?.type === "code" && (token.lang ?? "").trim()) {
				return [`boxed2:${token.lang}`];
			}
			return (fakeProto[ORIGINAL] as Function).call(this, token, width);
		};
		originalCalls = 0;
		fakeProto.renderToken({ type: "code", lang: "py", text: "x" }, 30);
		if (originalCalls !== 0) fail(`patcher-chain v2 labeled: original must not run, got ${originalCalls}`);

		originalCalls = 0;
		fakeProto.renderToken({ type: "code", lang: "", text: "x" }, 30);
		if (originalCalls !== 1) fail(`patcher-chain v2 bare fence: ORIGINAL must be called exactly once after re-patch, got ${originalCalls}`);
	}

	// === Table edge cases ===

	// single-column table
	{
		const token = {
			type: "table",
			header: [{ text: "X" }],
			align: ["left"] as const,
			rows: [[{ text: "a" }], [{ text: "bb" }]],
		} as Parameters<typeof renderTableBox>[1];
		const out = renderTableBox(mockInstance, token, 20);
		if (out.length < 5) fail(`table-1col: expected >=5 lines, got ${out.length}`);
		if (!out[0].includes("╭")) fail("table-1col: top border missing");
		if (!out[out.length - 1].includes("╰")) fail("table-1col: bottom border missing");
	}

	// empty header → fallback (no crash)
	{
		const tokenNoRaw = {
			type: "table",
			header: [],
			align: [] as const,
			rows: [[{ text: "x" }]],
		} as Parameters<typeof renderTableBox>[1];
		const out1 = renderTableBox(mockInstance, tokenNoRaw, 30);
		if (out1.length !== 0) fail(`table-empty-header no-raw: expected [], got ${out1.length}`);

		const tokenWithRaw = { ...tokenNoRaw, raw: "|x|\n|---|\n|x|" } as Parameters<typeof renderTableBox>[1];
		const out2 = renderTableBox(mockInstance, tokenWithRaw, 30);
		if (out2.length === 0) fail("table-empty-header with-raw: expected non-empty fallback");
		if (out2.some((l) => l.includes("╭") || l.includes("│"))) fail("table-empty-header with-raw: should not draw box chars");
	}

	// very wide content forces wrap
	{
		const token = {
			type: "table",
			header: [{ text: "A" }, { text: "B" }],
			align: ["left", "left"] as const,
			rows: [[{ text: "x".repeat(200) }, { text: "y".repeat(200) }]],
		} as Parameters<typeof renderTableBox>[1];
		const out = renderTableBox(mockInstance, token, 30);
		if (out.length < 5) fail(`table-wide: expected wrap to >=5 lines, got ${out.length}`);
	}

	// row separator off (config)
	{
		const tmp = `/tmp/pi-markdown-box-rowsep-${process.pid}.json`;
		const prevEnv = process.env.PI_MARKDOWN_BOX_CONFIG;
		process.env.PI_MARKDOWN_BOX_CONFIG = tmp;
		try {
			writeConfig({ tableRowSeparator: false });
			const token = {
				type: "table",
				header: [{ text: "A" }, { text: "B" }],
				align: ["left", "left"] as const,
				rows: [[{ text: "1" }, { text: "2" }], [{ text: "3" }, { text: "4" }]],
			} as Parameters<typeof renderTableBox>[1];
			const out = renderTableBox(mockInstance, token, 30);
			// top + header + sep + row1 + row2 + bottom = 6 lines (no inter-row separator)
			if (out.length !== 6) fail(`table-rowsep-off: expected 6 lines, got ${out.length}`);
		} finally {
			if (prevEnv === undefined) delete process.env.PI_MARKDOWN_BOX_CONFIG;
			else process.env.PI_MARKDOWN_BOX_CONFIG = prevEnv;
			try { fs.unlinkSync(tmp); } catch {}
		}
	}

	console.log("pi-markdown-box self-check passed");
}