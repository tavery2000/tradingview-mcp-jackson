#!/usr/bin/env node
/**
 * ask-cli.js — Interactive REPL over ask.answerQuestion().
 *
 * Run as the 4th HANK CMD window:  node ask-cli.js
 *
 * Pure additive — never writes, never imports from monitors. Loads
 * ask.js (read-only state surface) and pipes user text through readline.
 * Color palette mirrors news.js / monitor.js: green prompt, cyan
 * answers, red errors, gray help text.
 */

import readline from 'readline';
import { answerQuestion, helpText } from './ask.js';

// ─── Colors (match existing project style) ──────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

const PROMPT = `${C.green}⬡ hank>${C.reset} `;

function banner() {
  console.log('');
  console.log(`${C.bold}${C.green}HANK ASK${C.reset}  ${C.gray}— local-state Q&A. Type ${C.reset}${C.cyan}help${C.reset}${C.gray} for commands, ${C.reset}${C.cyan}quit${C.reset}${C.gray} to leave.${C.reset}`);
  console.log('');
}

// Color-code an answer based on simple heuristics. Plain text is cyan;
// "No data" / error-y first lines tint yellow; explicit failures (exception
// messages from ask.js) tint red. ask.js emits plain strings — coloring
// stays here so the answerQuestion API stays free of ANSI codes.
function colorize(answer) {
  if (!answer) return '';
  const lo = answer.toLowerCase();
  if (lo.startsWith('unknown command')) return `${C.red}${answer}${C.reset}`;
  if (/not found|no data|not yet/.test(answer.split('\n')[0].toLowerCase())) {
    return `${C.yellow}${answer}${C.reset}`;
  }
  // Help text rendered in gray for visual hierarchy
  if (answer.startsWith('HANK ASK —')) return `${C.gray}${answer}${C.reset}`;
  // Default — cyan body with bold first line if it looks like a heading
  const lines = answer.split('\n');
  if (lines.length > 1 && /^[A-Z][A-Z 0-9—()]+$/.test(lines[0].trim())) {
    return `${C.bold}${C.cyan}${lines[0]}${C.reset}\n${C.cyan}${lines.slice(1).join('\n')}${C.reset}`;
  }
  return `${C.cyan}${answer}${C.reset}`;
}

function isExit(line) {
  const lo = line.trim().toLowerCase();
  return lo === 'quit' || lo === 'exit' || lo === ':q' || lo === ':wq';
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: PROMPT,
  terminal: true,
});

banner();
rl.prompt();

rl.on('line', async (line) => {
  if (isExit(line)) { rl.close(); return; }
  const text = line.trim();
  if (!text) { rl.prompt(); return; }
  try {
    const ans = await answerQuestion(text);
    console.log(colorize(ans));
  } catch (e) {
    // ask.js shouldn't throw, but if it does we don't want to kill the REPL
    console.log(`${C.red}error: ${e.message}${C.reset}`);
  }
  console.log('');
  rl.prompt();
});

rl.on('close', () => {
  console.log(`${C.gray}bye.${C.reset}`);
  process.exit(0);
});

// Ctrl-C — exit cleanly, no stack trace
rl.on('SIGINT', () => {
  console.log('');
  rl.close();
});
