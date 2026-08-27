/**
 * Table boxing — width-aware cell wrapping with rounded-corner boxes.
 * Reuses pi-tui's column-width algorithm and wrapTextWithAnsi (CJK-aware).
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getConfig, makeStyler, type MarkdownLike } from "./theme";

type Cell = {
	text?: string;
	content?: string;
	tokens?: unknown[];
};

type Alignment = "left" | "right" | "center" | null;

type TableToken = {
	type: "table";
	header: Cell[];
	align?: Alignment[];
	rows: Cell[][];
	raw?: string;
};

const MIN_TABLE_WIDTH = 12;

/** Box-drawing chars for tables. Rounded outer corners, square junctions. */
const BOX = {
	tl: "╭",
	tr: "╮",
	bl: "╰",
	br: "╯",
	tj: "┬",
	bj: "┴",
	lj: "├",
	rj: "┤",
	xj: "┼",
	h: "─",
	v: "│",
} as const;

function longestWordWidth(text: string, cap = 30): number {
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	let longest = 0;
	for (const word of words) longest = Math.max(longest, visibleWidth(word));
	return Math.min(longest, cap);
}

/** Column-width allocation. Mirrors pi-tui's built-in renderTable algorithm. */
function allocateColumnWidths(
	naturalWidths: number[],
	minWordWidths: number[],
	available: number,
): number[] {
	const numCols = naturalWidths.length;
	let minColumnWidths = [...minWordWidths];
	let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

	if (minCellsWidth > available) {
		// Even min words can't fit — distribute proportionally from 1 each
		minColumnWidths = new Array(numCols).fill(1);
		const remaining = available - numCols;
		if (remaining > 0) {
			const totalWeight = minWordWidths.reduce((total, w) => total + Math.max(0, w - 1), 0);
			const growth = minWordWidths.map((w) => {
				const weight = Math.max(0, w - 1);
				return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
			});
			for (let i = 0; i < numCols; i++) minColumnWidths[i] += growth[i] ?? 0;
			const allocated = growth.reduce((a, w) => a + w, 0);
			let leftover = remaining - allocated;
			for (let i = 0; leftover > 0 && i < numCols; i++) {
				minColumnWidths[i]++;
				leftover--;
			}
		}
		minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
	}

	const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0);
	if (totalNaturalWidth <= available) {
		return naturalWidths.map((w, i) => Math.max(w, minColumnWidths[i]));
	}

	const totalGrowPotential = naturalWidths.reduce(
		(total, w, i) => total + Math.max(0, w - minColumnWidths[i]),
		0,
	);
	const extraWidth = Math.max(0, available - minCellsWidth);
	const columnWidths = minColumnWidths.map((minW, i) => {
		const delta = Math.max(0, naturalWidths[i] - minW);
		const grow = totalGrowPotential > 0 ? Math.floor((delta / totalGrowPotential) * extraWidth) : 0;
		return minW + grow;
	});

	// Distribute rounding remainder to columns that still have room
	const allocated = columnWidths.reduce((a, b) => a + b, 0);
	let remaining = available - allocated;
	while (remaining > 0) {
		let grew = false;
		for (let i = 0; i < numCols && remaining > 0; i++) {
			if (columnWidths[i] < naturalWidths[i]) {
				columnWidths[i]++;
				remaining--;
				grew = true;
			}
		}
		if (!grew) break;
	}

	return columnWidths;
}

function alignText(text: string, width: number, alignment: Alignment): string {
	const visible = visibleWidth(text);
	if (visible >= width) return text;
	const space = width - visible;
	switch (alignment) {
		case "right":
			return " ".repeat(space) + text;
		case "center": {
			const left = Math.floor(space / 2);
			return " ".repeat(left) + text + " ".repeat(space - left);
		}
		case "left":
		default:
			return text + " ".repeat(space);
	}
}

function getCellText(instance: MarkdownLike, cell: Cell): string {
	// Inline rendering would lose styling (bold/links/code). Fall back to raw text.
	// ponytail: skip inline render — most cells are plain; this avoids type-juggling renderInlineTokens.
	return cell.text ?? cell.content ?? "";
}

function fallback(token: TableToken, width: number, nextTokenType?: string): string[] {
	const out = token.raw ? wrapTextWithAnsi(token.raw, width) : [];
	if (nextTokenType && nextTokenType !== "space") out.push("");
	return out;
}

export function renderTableBox(
	instance: MarkdownLike,
	token: TableToken,
	width: number,
	nextTokenType?: string,
): string[] {
	const config = getConfig();
	const numCols = token.header?.length ?? 0;

	if (numCols === 0 || width < MIN_TABLE_WIDTH) {
		return fallback(token, width, nextTokenType);
	}

	// Border overhead: ╭ + ─ + [col0] + (─┬─)×(n-1) + ─ + ╮ = 3n+1
	const borderOverhead = 3 * numCols + 1;
	const availableForCells = width - borderOverhead;
	if (availableForCells < numCols) {
		return fallback(token, width, nextTokenType);
	}

	const headerCells = token.header.map((c) => getCellText(instance, c));
	const rowCells = token.rows.map((row) => row.map((c) => getCellText(instance, c)));

	const naturalWidths: number[] = [];
	const minWordWidths: number[] = [];
	for (let i = 0; i < numCols; i++) {
		naturalWidths[i] = visibleWidth(headerCells[i] ?? "");
		minWordWidths[i] = Math.max(1, longestWordWidth(headerCells[i] ?? "", 30));
	}
	for (const row of rowCells) {
		for (let i = 0; i < row.length; i++) {
			naturalWidths[i] = Math.max(naturalWidths[i] ?? 0, visibleWidth(row[i]));
			minWordWidths[i] = Math.max(minWordWidths[i] ?? 1, longestWordWidth(row[i], 30));
		}
	}

	const columnWidths = allocateColumnWidths(naturalWidths, minWordWidths, availableForCells);

	const out: string[] = [];
	const styleBorder = makeStyler(
		instance.theme?.codeBlockBorder ?? ((s) => s),
		config.borderColor,
	);
	const styleLabel = makeStyler(
		instance.theme?.code ?? instance.theme?.codeBlock ?? ((s) => s),
		config.labelColor,
	);

	// Top border: ╭─[w0]─┬─[w1]─┬─...─[wn-1]─╮
	const topCells = columnWidths.map((w) => styleBorder(BOX.h.repeat(w)));
	out.push(`${styleBorder(BOX.tl)}${styleBorder("─")}${topCells.join(styleBorder(`─${BOX.tj}─`))}${styleBorder(`─${BOX.tr}`)}`);

	// Header (bold/label-styled)
	out.push(...renderTableRow(headerCells, columnWidths, token.align ?? [], styleBorder, styleLabel));

	// Header-body separator: ├─┼─┤
	const sepCells = columnWidths.map((w) => styleBorder(BOX.h.repeat(w)));
	const separatorLine = `${styleBorder(BOX.lj)}${styleBorder("─")}${sepCells.join(styleBorder(`─${BOX.xj}─`))}${styleBorder(`─${BOX.rj}`)}`;
	out.push(separatorLine);

	// Data rows with optional row separator between them
	const showRowSep = config.tableRowSeparator !== false;
	for (let r = 0; r < rowCells.length; r++) {
		out.push(...renderTableRow(rowCells[r], columnWidths, token.align ?? [], styleBorder, null));
		if (showRowSep && r < rowCells.length - 1) {
			out.push(separatorLine);
		}
	}

	// Bottom border: ╰─┴─╯
	const bottomCells = columnWidths.map((w) => styleBorder(BOX.h.repeat(w)));
	out.push(`${styleBorder(BOX.bl)}${styleBorder("─")}${bottomCells.join(styleBorder(`─${BOX.bj}─`))}${styleBorder(`─${BOX.br}`)}`);

	if (nextTokenType && nextTokenType !== "space") out.push("");
	return out;
}

function renderTableRow(
	cells: string[],
	colWidths: number[],
	alignments: Alignment[],
	styleBorder: (s: string) => string,
	cellStyler: ((s: string) => string) | null,
): string[] {
	const cellLines: string[][] = cells.map((text, i) => {
		const wrapped = wrapTextWithAnsi(text, colWidths[i]);
		return wrapped.length ? wrapped : [""];
	});
	const maxLines = Math.max(...cellLines.map((c) => c.length), 1);
	const lines: string[] = [];

	for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
		const parts: string[] = [];
		for (let col = 0; col < cells.length; col++) {
			const text = cellLines[col][lineIdx] ?? "";
			const aligned = alignText(text, colWidths[col], alignments[col] ?? null);
			const styled = cellStyler ? cellStyler(aligned) : aligned;
			parts.push(styled);
		}
		lines.push(`${styleBorder(BOX.v)} ${parts.join(` ${styleBorder(BOX.v)} `)} ${styleBorder(BOX.v)}`);
	}
	return lines;
}