"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeAgentCommand = makeAgentCommand;
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Registry of supported frameworks.
// Each driver knows how to configure itself for a given workspace.
const DRIVERS = {
    openclaw: configureOpenclaw,
};
function makeAgentCommand() {
    const cmd = new commander_1.Command("agent");
    cmd.description("manage agent integrations");
    cmd
        .command("configure <framework>")
        .description("install OpenHive hooks and skills into an agent framework")
        .option("-w, --workspace <path>", "target a specific workspace path (used by experiment tooling)")
        .action((framework, opts) => {
        const driver = DRIVERS[framework.toLowerCase()];
        if (!driver) {
            console.error(`Unknown framework: ${framework}`);
            console.error(`Supported: ${Object.keys(DRIVERS).join(", ")}`);
            process.exit(1);
        }
        driver(opts.workspace ? path_1.default.resolve(opts.workspace) : null);
    });
    return cmd;
}
// ── OpenClaw driver ──────────────────────────────────────────────────────────
// Hooks installed via `openclaw hooks install` (when no workspace) or file copy (targeted workspace).
const OPENCLAW_HOOKS = [
    { name: "ioc-inject", files: ["HOOK.md", "package.json", "handler.js", "IOC_INSTRUCTIONS.md"] },
    { name: "session-start", files: ["HOOK.md", "package.json", "handler.js"] },
    { name: "conversation-extractor", files: ["HOOK.md", "package.json", "handler.js"] },
];
// Skills are always installed as file copies (no `openclaw skills install` command exists).
const OPENCLAW_SKILLS = [
    { name: "sstp", files: ["SKILL.md"] },
];
function configureOpenclaw(workspace) {
    const hooksRoot = path_1.default.join(__dirname, "..", "..", "hooks");
    const skillsRoot = path_1.default.join(__dirname, "..", "..", "skills");
    if (workspace) {
        // ── Targeted install (experiment framework) — file copy ──────────────────
        console.log(`Configuring OpenClaw workspace: ${workspace}`);
        if (!fs_1.default.existsSync(workspace)) {
            console.error(`Workspace not found: ${workspace}`);
            process.exit(1);
        }
        for (const hook of OPENCLAW_HOOKS) {
            const destDir = path_1.default.join(workspace, "hooks", hook.name);
            fs_1.default.mkdirSync(destDir, { recursive: true });
            for (const file of hook.files) {
                fs_1.default.copyFileSync(path_1.default.join(hooksRoot, hook.name, file), path_1.default.join(destDir, file));
                console.log(`  installed  hooks/${hook.name}/${file}`);
            }
        }
        for (const skill of OPENCLAW_SKILLS) {
            const destDir = path_1.default.join(workspace, "skills", skill.name);
            fs_1.default.mkdirSync(destDir, { recursive: true });
            for (const file of skill.files) {
                fs_1.default.copyFileSync(path_1.default.join(skillsRoot, skill.name, file), path_1.default.join(destDir, file));
                console.log(`  installed  skills/${skill.name}/${file}`);
            }
        }
    }
    else {
        // ── Global install — use openclaw CLI ────────────────────────────────────
        console.log("Configuring OpenClaw (global workspace)...");
        for (const hook of OPENCLAW_HOOKS) {
            const hookPath = path_1.default.join(hooksRoot, hook.name);
            try {
                (0, child_process_1.execSync)(`openclaw hooks install "${hookPath}"`, { stdio: "inherit" });
            }
            catch {
                console.error(`  failed to install hook: ${hook.name}`);
            }
        }
        // Skills: copy into the global openclaw workspace skills dir
        const globalWorkspace = path_1.default.join(process.env.HOME ?? "~", ".openclaw", "workspace");
        for (const skill of OPENCLAW_SKILLS) {
            const destDir = path_1.default.join(globalWorkspace, "skills", skill.name);
            fs_1.default.mkdirSync(destDir, { recursive: true });
            for (const file of skill.files) {
                fs_1.default.copyFileSync(path_1.default.join(skillsRoot, skill.name, file), path_1.default.join(destDir, file));
                console.log(`  installed  skills/${skill.name}/${file}`);
            }
        }
    }
    console.log(`\nDone. Restart your OpenClaw gateway to pick up the changes.`);
}
