import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const DEFAULT_JOURNAL_PATH = "docs/human_journal.md";
const JOURNAL_HEADER = "# Human supervision journal\n\nQuoted `User message` records are exact submitted prompts.\n";

function journalPath(ctx: { cwd: string }): string {
	const configured = process.env.PI_RECORD_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH;
	return isAbsolute(configured) ? configured : resolve(ctx.cwd, configured);
}

function appendJournal(path: string, record: string): void {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		writeFileSync(path, JOURNAL_HEADER, { encoding: "utf8", mode: 0o600 });
	}
	const existing = readFileSync(path, "utf8");
	const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	appendFileSync(path, `${separator}${record}`, "utf8");
}

async function offerGitignore(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const root = spawnSync("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (root.error) throw root.error;
	if (root.status === 128 && root.stderr.includes("not a git repository")) return;
	if (root.status !== 0) throw new Error(root.stderr);
	const path = journalPath(ctx);
	let ancestor = path;
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	const canonicalPath = resolve(realpathSync(ancestor), relative(ancestor, path));
	const repoRoot = root.stdout.trim();
	const repoPath = relative(repoRoot, canonicalPath);
	if (repoPath === ".." || repoPath.startsWith("../") || isAbsolute(repoPath)) return;
	const tracked = spawnSync("git", ["-C", repoRoot, "--literal-pathspecs", "ls-files", "--", repoPath], { encoding: "utf8" });
	if (tracked.error) throw tracked.error;
	if (tracked.status !== 0) throw new Error(tracked.stderr);
	if (tracked.stdout.trim()) {
		ctx.ui.notify(`Journal already tracked by Git: ${repoPath}. New entries will show in git diff. To stop tracking: git rm --cached -- ${repoPath}, then add it to .gitignore.`, "info");
		return;
	}
	const ignored = spawnSync("git", ["-C", repoRoot, "check-ignore", "--quiet", "--", repoPath]);
	if (ignored.error) throw ignored.error;
	if (ignored.status === 0) {
		ctx.ui.notify(`Journal already ignored by Git: ${repoPath}.`, "info");
		return;
	}
	if (ignored.status !== 1) throw new Error(ignored.stderr.toString());
	const ignorePath = resolve(repoRoot, ".gitignore");
	const options = ["Ignore journal (default)", "Keep journal visible to Git"];
	const choice = await ctx.ui.select(
		`Add ${repoPath} to ${ignorePath}?\nAlready tracked files remain tracked. Esc leaves .gitignore unchanged.`,
		options,
		{ timeout: DIALOG_TIMEOUT_MS },
	);
	if (choice === options[0]) {
		const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
		const pattern = "/" + repoPath.replace(/[\\*?\[\] ]/g, "\\$&");
		appendFileSync(ignorePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${pattern}\n`, "utf8");
	}
	pi.appendEntry("pi-annotate-gitignore", {
		sessionId: ctx.sessionManager.getSessionId(),
		journalPath: path,
		gitignorePath: ignorePath,
		choice: choice ?? "cancelled",
	});
	ctx.ui.notify(choice === options[0]
		? `Journal added to .gitignore: ${repoPath}. To undo, remove its rule from ${ignorePath}.`
		: `Journal ${choice ? "kept visible to Git" : "ignore choice cancelled"}; .gitignore unchanged. Change: /journal-settings auto on.`, "info");
}

interface AnnotateSettings {
	sessionId: string;
	autoAnnotate: boolean;
}

function annotateSettings(ctx: Pick<ExtensionContext, "sessionManager">): AnnotateSettings | undefined {
	const sessionId = ctx.sessionManager.getSessionId();
	for (const entry of ctx.sessionManager.getEntries().reverse()) {
		if (entry.type !== "custom" || entry.customType !== "pi-annotate-settings") continue;
		const settings = entry.data as AnnotateSettings;
		if (settings.sessionId === sessionId) return settings;
	}
	return undefined;
}

function autoAnnotateEnabled(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	return annotateSettings(ctx)?.autoAnnotate === true;
}

function notifyRecordingChoice(ctx: ExtensionContext, enabled: boolean): void {
	if (ctx.hasUI) ctx.ui.notify(`Auto-saving ${enabled ? "on" : "off"} (this session). Change: /journal-settings auto ${enabled ? "off" : "on"}.`, "info");
}

// Unanswered dialogs count as "no", so an agent-driven pane is never stuck on them.
const DIALOG_TIMEOUT_MS = 60_000;

function saveMessage(ctx: ExtensionContext, text: string): void {
	const quoted = text.replace(/\r\n/g, "\n").split("\n").map(line => line ? `> ${line}` : ">").join("\n");
	const path = journalPath(ctx);
	appendJournal(path, `## ${new Date().toISOString()} · User message\n\nSaved by pi-record-journal · session \`${ctx.sessionManager.getSessionId()}\`\n\n${quoted}\n`);
	if (ctx.hasUI) ctx.ui.notify(`long user message appended to ${path}`, "info");
}

export default function (pi: ExtensionAPI) {
	// Long messages sent while the consent dialog is open; saved if the user accepts.
	let held: string[] | undefined;

	async function askConsent(ctx: ExtensionContext): Promise<void> {
		const accepted = await ctx.ui.confirm(
			"Automatically save long user messages?",
			`Save this message and future messages with at least 3 non-empty, non-quoted lines to ${journalPath(ctx)}? This applies only to this session. Change it with /journal-settings.`,
			{ timeout: DIALOG_TIMEOUT_MS },
		);
		pi.appendEntry("pi-annotate-settings", {
			sessionId: ctx.sessionManager.getSessionId(),
			autoAnnotate: accepted,
		} satisfies AnnotateSettings);
		notifyRecordingChoice(ctx, accepted);
		const texts = held!;
		held = undefined;
		if (!accepted) return;
		await offerGitignore(pi, ctx);
		for (const text of texts) saveMessage(ctx, text);
	}

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		// pi-annotate-md (/annotate) sections are mostly quoted Pi output and already logged there; keep only the user's own text.
		const text = event.text.split(/^## Annotate (?:user|assistant) message$/m)[0].trimEnd();
		const unquotedLines = text.split(/\r?\n/).filter((line) => {
			const trimmed = line.trim();
			return trimmed.length > 0 && !trimmed.startsWith(">");
		});
		if (unquotedLines.length < 3) return { action: "continue" };
		// Never hold the message for the dialog: ask in the background and save afterwards.
		if (!annotateSettings(ctx) && ctx.hasUI) {
			if (held) held.push(text);
			else {
				held = [text];
				askConsent(ctx).catch((error) => { held = undefined; ctx.ui.notify(`pi-record-journal: ${String(error)}`, "error"); });
			}
			return { action: "continue" };
		}
		if (autoAnnotateEnabled(ctx)) saveMessage(ctx, text);
		return { action: "continue" };
	});

	pi.registerCommand("journal-settings", {
		description: "Save long user messages to the journal in this session (off by default)",
		getArgumentCompletions: (prefix) => ["auto off", "auto on"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const option = args.trim();
			let choice = option;
			if (!option) {
				if (!ctx.hasUI) return;
				const selected = await ctx.ui.select(
					`Record long user messages: ${autoAnnotateEnabled(ctx) ? "on" : "off"} (this session)`,
					["auto off", "auto on"],
				);
				if (!selected) return;
				choice = selected;
			}
			if (choice !== "auto on" && choice !== "auto off") {
				ctx.ui.notify("Usage: /journal-settings [auto on|off]", "warning");
				return;
			}
			try {
				pi.appendEntry("pi-annotate-settings", {
					sessionId: ctx.sessionManager.getSessionId(),
					autoAnnotate: choice === "auto on",
				} satisfies AnnotateSettings);
				notifyRecordingChoice(ctx, choice === "auto on");
				if (choice === "auto on") await offerGitignore(pi, ctx);
			} catch (error) {
				ctx.ui.notify(`Could not save annotation settings: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

}
