import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerExtension from "../index.ts";

function loadExtension(getSession: () => SessionManager, directory: string) {
	const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
	let input!: (event: { text: string; source: string }, ctx: any) => Promise<{ action: string }>;
	registerExtension({
		on(_event: string, handler: typeof input) { input = handler; },
		registerCommand(name: string, options: any) { commands.set(name, options); },
		appendEntry(customType: string, data: unknown) { getSession().appendCustomEntry(customType, data); },
	} as never);
	const notifications: string[] = [];
	const ctx = {
		cwd: directory,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message), confirm: async () => false },
		get sessionManager() { return getSession(); },
	};
	return { commands, input, notifications, ctx };
}

test("first long message asks once, saves only with consent, and remembers the answer after reload", async (t) => {
	for (const accepted of [true, false]) {
		await t.test(accepted ? "accept" : "decline or dismiss", async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-annotate-prompt-"));
			const journalPath = join(directory, "journal.md");
			const previousJournal = process.env.PI_RECORD_JOURNAL;
			process.env.PI_RECORD_JOURNAL = journalPath;
			try {
				let session = SessionManager.inMemory(directory);
				const extension = loadExtension(() => session, directory);
				let prompts = 0;
				let resolveConfirmation!: (accepted: boolean) => void;
				const ui = {
					...extension.ctx.ui,
					confirm: async (title: string, message: string, opts?: { timeout?: number }) => {
						prompts += 1;
						assert.match(title, /save long user messages/);
						assert.ok(message.includes(journalPath));
						assert.match(message, /only to this session/);
						assert.ok(opts?.timeout, "an unanswered dialog must time out");
						return new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
					},
				};
				const ctx = { ...extension.ctx, ui };
				for (const text of ["one\ntwo", "> one\n> two\n> three", "one\n\n> quote\ntwo"]) {
					await extension.input({ text, source: "interactive" }, ctx);
				}
				await extension.input({ text: "one\ntwo\nthree", source: "extension" }, ctx);
				await extension.input({ text: "headless\nlong\nmessage", source: "rpc" }, { ...ctx, hasUI: false });
				assert.equal(prompts, 0);
				assert.equal(session.getEntries().length, 0);
				// The message goes through while the dialog is still open; a second one waits with it.
				assert.deepEqual(await extension.input({ text: "first\nlong\nmessage", source: "interactive" }, ctx), { action: "continue" });
				assert.deepEqual(await extension.input({ text: "during\nthe\ndialog", source: "interactive" }, ctx), { action: "continue" });
				assert.equal(prompts, 1);
				assert.equal(existsSync(journalPath), false);
				resolveConfirmation(accepted);
				await new Promise(resolve => setTimeout(resolve, 20));
				assert.ok(extension.notifications.some(message => message.includes(`Auto-saving ${accepted ? "on" : "off"}`) && message.includes("/journal-settings")));
				assert.equal(existsSync(journalPath), accepted);
				const reloaded = loadExtension(() => session, directory);
				await reloaded.input({ text: "second\nlong\nmessage", source: "interactive" }, { ...reloaded.ctx, ui });
				assert.equal(prompts, 1);
				assert.equal(existsSync(journalPath), accepted);
				if (accepted) {
					const journal = readFileSync(journalPath, "utf8");
					assert.match(journal, /> first\n> long\n> message/);
					assert.match(journal, /> during\n> the\n> dialog/);
					assert.match(journal, /> second\n> long\n> message/);
					assert.equal((journal.match(/· User message/g) ?? []).length, 3);
				}
				session = SessionManager.inMemory(directory);
				await reloaded.input({ text: "new\nsession\nmessage", source: "interactive" }, { ...reloaded.ctx, ui });
				assert.equal(prompts, 2);
				resolveConfirmation(false);
				await new Promise(resolve => setTimeout(resolve, 20));
			} finally {
				if (previousJournal === undefined) delete process.env.PI_RECORD_JOURNAL;
				else process.env.PI_RECORD_JOURNAL = previousJournal;
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
});

test("gitignore is a separate opt-in and ignores only the journal", async (t) => {
	for (const scenario of ["accept", "decline", "cancel", "already ignored", "already tracked", "outside repository", "headless", "symlink cwd"]) {
		await t.test(scenario, async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-annotate-ignore-"));
			const repo = join(directory, "repo");
			mkdirSync(repo);
			execFileSync("git", ["init", "--quiet", repo]);
			const ignorePath = join(repo, ".gitignore");
			const existing = scenario === "already ignored" ? "/notes/\n" : "other-file";
			writeFileSync(ignorePath, existing);
			let cwd = repo;
			if (scenario === "symlink cwd") {
				cwd = join(directory, "alias");
				symlinkSync(repo, cwd, "dir");
			}
			const journalPath = scenario === "outside repository" ? join(directory, "outside.md") : join(cwd, "notes", "journal[1].md");
			if (scenario === "already tracked") {
				mkdirSync(join(repo, "notes"));
				writeFileSync(journalPath, "old\n");
				execFileSync("git", ["-C", repo, "--literal-pathspecs", "add", "notes/journal[1].md"]);
			}
			const previousJournal = process.env.PI_RECORD_JOURNAL;
			process.env.PI_RECORD_JOURNAL = journalPath;
			try {
				const session = SessionManager.inMemory(cwd);
				const extension = loadExtension(() => session, cwd);
				let ignorePrompts = 0;
				const ctx = {
					...extension.ctx,
					hasUI: scenario !== "headless",
					ui: {
						...extension.ctx.ui,
						confirm: async () => true,
						select: async (title: string, options: string[]) => {
							assert.ok(title.includes(ignorePath));
							assert.deepEqual(options, ["Ignore journal (default)", "Keep journal visible to Git"]);
							ignorePrompts += 1;
							assert.equal(readFileSync(ignorePath, "utf8"), existing);
							return scenario === "cancel" ? undefined : options[scenario === "decline" ? 1 : 0];
						},
					},
				};
				if (scenario === "accept") {
					await extension.input({ text: "first\nlong\nmessage", source: "interactive" }, ctx);
					await new Promise(resolve => setTimeout(resolve, 20));
				}
				else await extension.commands.get("journal-settings")!.handler("auto on", ctx);
				const shouldAsk = ["accept", "decline", "cancel", "symlink cwd"].includes(scenario);
				if (scenario === "already tracked") assert.ok(extension.notifications.some(message => message.includes("already tracked by Git: notes/journal[1].md")));
				if (scenario === "already ignored") assert.ok(extension.notifications.some(message => message.includes("already ignored by Git")));
				assert.equal(ignorePrompts, shouldAsk ? 1 : 0);
				const shouldAppend = scenario === "accept" || scenario === "symlink cwd";
				assert.equal(readFileSync(ignorePath, "utf8"), shouldAppend ? `${existing}\n/notes/journal\\[1\\].md\n` : existing);
				const choices = session.getEntries().filter(entry => entry.type === "custom" && entry.customType === "pi-annotate-gitignore");
				assert.equal(choices.length, shouldAsk ? 1 : 0);
				if (shouldAsk) {
					const choice = choices[0];
					assert.equal(choice.type, "custom");
					assert.deepEqual((choice as any).data, {
						sessionId: session.getSessionId(), journalPath, gitignorePath: ignorePath,
						choice: scenario === "cancel" ? "cancelled" : scenario === "decline" ? "Keep journal visible to Git" : "Ignore journal (default)",
					});
					assert.ok(extension.notifications.some(message => message.includes(shouldAppend ? "Journal added to .gitignore" : ".gitignore unchanged") && message.includes(shouldAppend ? "To undo" : "/journal-settings")));
				}
				if (shouldAppend) {
					assert.equal(spawnSync("git", ["-C", repo, "check-ignore", "--quiet", "--", "notes/journal[1].md"]).status, 0);
					assert.equal(spawnSync("git", ["-C", repo, "check-ignore", "--quiet", "--", "notes/journal1.md"]).status, 1);
					await extension.commands.get("journal-settings")!.handler("auto on", ctx);
					assert.equal(ignorePrompts, 1);
				}
				await extension.input({ text: "next\nlong\nmessage", source: "interactive" }, ctx);
				assert.equal(ignorePrompts, shouldAsk ? 1 : 0);
				assert.equal(existsSync(journalPath), true);
			} finally {
				if (previousJournal === undefined) delete process.env.PI_RECORD_JOURNAL;
				else process.env.PI_RECORD_JOURNAL = previousJournal;
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
});

test("records only long unquoted input when enabled for this session", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-extension-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const previousJournal = process.env.PI_RECORD_JOURNAL;
	const journalPath = join(directory, "journal.md");
	process.env.PI_RECORD_JOURNAL = journalPath;
	try {
		writeFileSync(join(directory, "annotate.json"), JSON.stringify({ autoAnnotate: true }));
		const session = SessionManager.inMemory(directory);
		const { commands, input, notifications, ctx } = loadExtension(() => session, directory);
		await input({ text: "default\noff\nplease", source: "interactive" }, ctx);
		assert.equal(existsSync(journalPath), false);
		assert.deepEqual(notifications, ["Auto-saving off (this session). Change: /journal-settings auto on."]);
		const command = commands.get("journal-settings")!;
		await command.handler("auto on", ctx);
		notifications.length = 0;
		for (const text of ["", "ok", "first\nsecond", "first\n\n \nsecond\n", "> first\n> second\n> third", "first\n> quote\n  > indented quote\nsecond"]) {
			assert.deepEqual(await input({ text, source: "interactive" }, ctx), { action: "continue" });
		}
		assert.deepEqual(await input({ text: "first\nsecond\nthird", source: "extension" }, ctx), { action: "continue" });
		assert.equal(existsSync(journalPath), false);
		assert.deepEqual(notifications, []);
		assert.deepEqual(await input({ text: "first line\r\nsecond line\r\n> quote\r\nthird line", source: "interactive" }, ctx), { action: "continue" });
		const journal = readFileSync(journalPath, "utf8");
		assert.match(journal, /## .* · User message/);
		assert.ok(journal.includes(`Saved by pi-record-journal · session \`${session.getSessionId()}\``));
		assert.doesNotMatch(journal, /<!--/);
		assert.match(journal, /> first line\n> second line\n> > quote\n> third line/);
		assert.deepEqual(notifications, [`long user message appended to ${journalPath}`]);
		assert.doesNotMatch(journal, /long user message appended/);
		assert.deepEqual(await input({ text: "rpc first\nrpc second\nrpc third\nrpc fourth", source: "rpc" }, { ...ctx, hasUI: false }), { action: "continue" });
		assert.match(readFileSync(journalPath, "utf8"), /> rpc fourth/);
		assert.equal(notifications.length, 1);
		const section = "## Annotate assistant message\n\nassistant line one\nassistant line two\nassistant line three\n\n> an: note\n";
		await input({ text: section, source: "interactive" }, ctx);
		await input({ text: `own one\nown two\nown three\n\n${section}`, source: "interactive" }, ctx);
		const withAnnotations = readFileSync(journalPath, "utf8");
		assert.match(withAnnotations, /> own one\n> own two\n> own three\n/);
		assert.doesNotMatch(withAnnotations, /assistant line|> an: note/);
		await command.handler("auto off", ctx);
		const before = readFileSync(journalPath, "utf8");
		const reloaded = loadExtension(() => session, directory);
		await reloaded.input({ text: "not\nsaved\nnow", source: "interactive" }, reloaded.ctx);
		assert.equal(readFileSync(journalPath, "utf8"), before);
		const entries = session.getEntries().length;
		await command.handler("", { ...ctx, ui: { ...ctx.ui, select: async () => undefined } });
		await command.handler("invalid", ctx);
		assert.equal(session.getEntries().length, entries);
		await command.handler("", { ...ctx, ui: { ...ctx.ui, select: async () => "auto on" } });
		await reloaded.input({ text: "saved\nagain\nnow", source: "interactive" }, reloaded.ctx);
		assert.match(readFileSync(journalPath, "utf8"), /> saved\n> again\n> now/);
		assert.deepEqual(JSON.parse(readFileSync(join(directory, "annotate.json"), "utf8")), { autoAnnotate: true });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousJournal === undefined) delete process.env.PI_RECORD_JOURNAL;
		else process.env.PI_RECORD_JOURNAL = previousJournal;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("session preference survives resume and tree navigation without enabling another session or fork", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-session-"));
	const journalPath = join(directory, "journal.md");
	const previousJournal = process.env.PI_RECORD_JOURNAL;
	process.env.PI_RECORD_JOURNAL = journalPath;
	try {
		let session = SessionManager.create(directory, directory);
		const root = session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant", content: [{ type: "text", text: "hello" }],
			api: "openai-responses", provider: "openai", model: "test", stopReason: "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		const extension = loadExtension(() => session, directory);
		await extension.commands.get("journal-settings")!.handler("auto on", extension.ctx);
		const sessionFile = session.getSessionFile()!;
		session = SessionManager.open(sessionFile);
		const reloaded = loadExtension(() => session, directory);
		const record = () => reloaded.input({ text: "first\nsecond\nthird", source: "interactive" }, reloaded.ctx);
		await record();
		assert.equal(existsSync(journalPath), true);
		session.branch(root);
		await reloaded.commands.get("journal-settings")!.handler("auto off", reloaded.ctx);
		session.branch(root);
		const before = readFileSync(journalPath, "utf8");
		await record();
		assert.equal(readFileSync(journalPath, "utf8"), before);
		await reloaded.commands.get("journal-settings")!.handler("auto on", reloaded.ctx);
		session = SessionManager.forkFrom(sessionFile, directory, directory);
		assert.ok(session.getEntries().some(entry => entry.type === "custom" && entry.customType === "pi-annotate-settings"));
		await record();
		assert.equal(readFileSync(journalPath, "utf8"), before);
		session = SessionManager.inMemory(directory);
		await record();
		assert.equal(readFileSync(journalPath, "utf8"), before);
		session = SessionManager.open(sessionFile);
		await record();
		assert.ok(readFileSync(journalPath, "utf8").length > before.length);
	} finally {
		if (previousJournal === undefined) delete process.env.PI_RECORD_JOURNAL;
		else process.env.PI_RECORD_JOURNAL = previousJournal;
		rmSync(directory, { recursive: true, force: true });
	}
});
