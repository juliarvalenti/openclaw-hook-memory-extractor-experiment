import { execSync } from "child_process";

export function runInstall(): void {
  console.log("Checking dependencies...\n");

  check("Docker", () => execSync("docker info", { stdio: "pipe" }));
  check("OpenClaw CLI", () => execSync("openclaw --version", { stdio: "pipe" }));

  console.log("\nAll checks passed. Run `openhive start` to bring up the CFN node.");
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
  } catch {
    console.log(`  ✗  ${name}  (not found)`);
  }
}
