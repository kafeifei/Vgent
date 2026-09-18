#!/usr/bin/env node
// 递增 apps/desktop/build-number 并把 tauri.conf.json 的 version 同步为 0.1.<n>。
// 不在此脚本内调用 git —— 提交由调用方（人或 CI）决定。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const buildNumberPath = fileURLToPath(new URL("../build-number", import.meta.url));
const tauriConfPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));

const current = Number.parseInt(readFileSync(buildNumberPath, "utf8").trim(), 10);
const next = current + 1;
writeFileSync(buildNumberPath, `${next}\n`);

const version = `0.1.${next}`;
const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
conf.version = version;
writeFileSync(tauriConfPath, `${JSON.stringify(conf, null, 2)}\n`);

console.log(version);
