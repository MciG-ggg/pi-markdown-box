/**
 * Settings command: /markdown-box-settings [label|border|show|reset] ...
 * Aliased as /codeblock-settings for users upgrading from upstream pi-codeblock-box.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig, getConfigPath, writeConfig, formatConfig, normalizeColorInput, type MarkdownBoxConfig } from "./theme";

async function promptColor(
	ctx: any,
	field: "labelColor" | "borderColor",
	current: MarkdownBoxConfig,
): Promise<MarkdownBoxConfig | undefined> {
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

function buildHandler() {
	return async (args: string, ctx: any) => {
		const parsed = parseCommandArgs(args ?? "");
		let config = getConfig();

		if (parsed?.action === "show") {
			ctx.ui.notify(`Markdown box: ${formatConfig(config)} (${getConfigPath()})`, "info");
			return;
		}

		if (parsed?.action === "reset") {
			const configPath = writeConfig({ labelColor: "theme", borderColor: "theme" });
			ctx.ui.notify(`Markdown box reset to theme colors: ${configPath}`, "info");
			return;
		}

		if (parsed?.field) {
			const rawValue = parsed.value ?? "";
			const parts = rawValue.trim().split(/\s+/).filter(Boolean);
			if (parsed.field === "labelColor" && parts.length >= 2) {
				const lang = parts[0].toLowerCase();
				const normalized = normalizeColorInput(parts.slice(1).join(" "));
				if (!normalized) {
					ctx.ui.notify("Usage: /markdown-box-settings label text blue | label #ffb71b | border #2aa12b | show | reset", "error");
					return;
				}
				const configPath = writeConfig({ ...config, labelColors: { ...(config.labelColors ?? {}), [lang]: normalized } });
				ctx.ui.notify(`Saved ${lang} label color: ${normalized} (${configPath})`, "info");
				return;
			}
			const normalized = normalizeColorInput(rawValue);
			if (!normalized) {
				ctx.ui.notify("Usage: /markdown-box-settings label text blue | label #ffb71b | border #2aa12b | show | reset", "error");
				return;
			}
			const configPath = writeConfig({ ...config, [parsed.field]: normalized });
			ctx.ui.notify(`Saved markdown box settings: ${formatConfig(getConfig())} (${configPath})`, "info");
			return;
		}

		const labelColors = config.labelColors ?? {};
		const labelColorSummary = Object.keys(labelColors).length > 0
			? Object.entries(labelColors).map(([lang, color]) => `${lang}=${color}`).join(", ")
			: "none";

		const choice = await ctx.ui.select("Markdown box settings", [
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
			const ok = await ctx.ui.confirm("Reset markdown box colors?", "Use active Pi theme colors for both label and border.");
			if (!ok) return;
			const configPath = writeConfig({ labelColor: "theme", borderColor: "theme" });
			ctx.ui.notify(`Markdown box reset: ${configPath}`, "info");
		} else {
			ctx.ui.notify(`Config path: ${getConfigPath()}\nCurrent: ${formatConfig(config)}`, "info");
		}
	};
}

export function registerSettingsCommand(pi: ExtensionAPI) {
	const handler = buildHandler();
	pi.registerCommand("markdown-box-settings", {
		description: "Configure markdown box label and border colors (code blocks + tables)",
		handler,
	});
	// Backward-compat alias for users coming from upstream pi-codeblock-box.
	pi.registerCommand("codeblock-settings", {
		description: "Alias for /markdown-box-settings (kept for upstream compatibility)",
		handler,
	});
}