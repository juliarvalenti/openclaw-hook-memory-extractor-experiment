import { Command } from "commander";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

// Registry of supported frameworks.
// Each driver knows how to configure itself for a given workspace.
const DRIVERS: Record<string, (workspace: string | null) => void> = {
  openclaw: configureOpenclaw,
};

export function makeAgentCommand(): Command {
  const cmd = new Command("agent");
  cmd.description("manage agent integrations");

  cmd
    .command("configure <framework>")
    .description("install OpenHive hooks and skills into an agent framework")
    .option("-w, --workspace <path>", "target a specific workspace path (used by experiment tooling)")
    .action((framework: string, opts: { workspace?: string }) => {
      const driver = DRIVERS[framework.toLowerCase()];
      if (!driver) {
        console.error(`Unknown framework: ${framework}`);
        console.error(`Supported: ${Object.keys(DRIVERS).join(", ")}`);
        process.exit(1);
      }
      driver(opts.workspace ? path.resolve(opts.workspace) : null);
    });

  return cmd;
}

// ── OpenClaw driver ──────────────────────────────────────────────────────────

// Hooks installed via `openclaw hooks install` (when no workspace) or file copy (targeted workspace).
const OPENCLAW_HOOKS: { name: string; files: string[] }[] = [
  { name: "ioc-inject",             files: ["HOOK.md", "package.json", "handler.js", "IOC_INSTRUCTIONS.md"] },
  { name: "conversation-extractor", files: ["HOOK.md", "package.json", "handler.js"] },
];

// Skills are always installed as file copies (no `openclaw skills install` command exists).
const OPENCLAW_SKILLS: { name: string; files: string[] }[] = [
  { name: "sstp", files: ["SKILL.md"] },
];

function configureOpenclaw(workspace: string | null): void {
  const hooksRoot  = path.join(__dirname, "..", "..", "hooks");
  const skillsRoot = path.join(__dirname, "..", "..", "skills");

  if (workspace) {
    // ── Targeted install (experiment framework) — file copy ──────────────────
    console.log(`Configuring OpenClaw workspace: ${workspace}`);
    if (!fs.existsSync(workspace)) {
      console.error(`Workspace not found: ${workspace}`);
      process.exit(1);
    }

    for (const hook of OPENCLAW_HOOKS) {
      const destDir = path.join(workspace, "hooks", hook.name);
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of hook.files) {
        fs.copyFileSync(path.join(hooksRoot, hook.name, file), path.join(destDir, file));
        console.log(`  installed  hooks/${hook.name}/${file}`);
      }
    }

    for (const skill of OPENCLAW_SKILLS) {
      const destDir = path.join(workspace, "skills", skill.name);
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of skill.files) {
        fs.copyFileSync(path.join(skillsRoot, skill.name, file), path.join(destDir, file));
        console.log(`  installed  skills/${skill.name}/${file}`);
      }
    }

  } else {
    // ── Global install — use openclaw CLI ────────────────────────────────────
    console.log("Configuring OpenClaw (global workspace)...");

    for (const hook of OPENCLAW_HOOKS) {
      const hookPath = path.join(hooksRoot, hook.name);
      try {
        execSync(`openclaw hooks install "${hookPath}"`, { stdio: "inherit" });
      } catch {
        console.error(`  failed to install hook: ${hook.name}`);
      }
    }

    // Skills: copy into the global openclaw workspace skills dir
    const globalWorkspace = path.join(
      process.env.HOME ?? "~", ".openclaw", "workspace"
    );
    for (const skill of OPENCLAW_SKILLS) {
      const destDir = path.join(globalWorkspace, "skills", skill.name);
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of skill.files) {
        fs.copyFileSync(path.join(skillsRoot, skill.name, file), path.join(destDir, file));
        console.log(`  installed  skills/${skill.name}/${file}`);
      }
    }
  }

  console.log(`\nDone. Restart your OpenClaw gateway to pick up the changes.`);
}
