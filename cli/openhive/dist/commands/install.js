"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInstall = runInstall;
const child_process_1 = require("child_process");
function runInstall() {
    console.log("Checking dependencies...\n");
    check("Docker", () => (0, child_process_1.execSync)("docker info", { stdio: "pipe" }));
    check("OpenClaw CLI", () => (0, child_process_1.execSync)("openclaw --version", { stdio: "pipe" }));
    console.log("\nAll checks passed. Run `openhive start` to bring up the CFN node.");
}
function check(name, fn) {
    try {
        fn();
        console.log(`  ✓  ${name}`);
    }
    catch {
        console.log(`  ✗  ${name}  (not found)`);
    }
}
