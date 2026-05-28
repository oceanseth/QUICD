#!/usr/bin/env node
/**
 * Copies the QUICD Claude skill into the current project's .claude/skills dir
 * so an agent can discover it. Run from the consuming project's root:
 *
 *   npx quicd-install-skill            # project-level: ./.claude/skills/quicd
 *   npx quicd-install-skill --user     # personal:      ~/.claude/skills/quicd
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "skill", "SKILL.md");

const userScope = process.argv.includes("--user");
const base = userScope ? homedir() : process.cwd();
const destDir = join(base, ".claude", "skills", "quicd");
const dest = join(destDir, "SKILL.md");

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);

console.log(`QUICD skill installed → ${dest}`);
console.log("Restart Claude Code (or reload skills) so the agent can discover it.");
