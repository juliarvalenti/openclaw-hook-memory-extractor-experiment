#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const install_js_1 = require("./commands/install.js");
const start_js_1 = require("./commands/start.js");
const status_js_1 = require("./commands/status.js");
const watch_js_1 = require("./commands/watch.js");
const agent_js_1 = require("./commands/agent.js");
const program = new commander_1.Command();
program
    .name("openhive")
    .description("CFN node manager and agent integration layer")
    .version("0.1.0");
program
    .command("install")
    .description("check and install CFN dependencies")
    .action(install_js_1.runInstall);
program
    .command("start")
    .description("start the CFN node")
    .action(start_js_1.runStart);
program
    .command("status")
    .description("show CFN node status")
    .action(status_js_1.runStatus);
program
    .command("watch")
    .description("tail CFN node logs")
    .action(watch_js_1.runWatch);
program.addCommand((0, agent_js_1.makeAgentCommand)());
program.parse();
