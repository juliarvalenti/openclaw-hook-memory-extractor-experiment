#!/usr/bin/env node
import { Command } from "commander";
import { runInstall } from "./commands/install.js";
import { runStart } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runWatch } from "./commands/watch.js";
import { makeAgentCommand } from "./commands/agent.js";

const program = new Command();

program
  .name("openhive")
  .description("CFN node manager and agent integration layer")
  .version("0.1.0");

program
  .command("install")
  .description("check and install CFN dependencies")
  .action(runInstall);

program
  .command("start")
  .description("start the CFN node")
  .action(runStart);

program
  .command("status")
  .description("show CFN node status")
  .action(runStatus);

program
  .command("watch")
  .description("tail CFN node logs")
  .action(runWatch);

program.addCommand(makeAgentCommand());

program.parse();
