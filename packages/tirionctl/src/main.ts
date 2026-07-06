#!/usr/bin/env node
import { runTirionCtl } from "./index";

void runTirionCtl(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
