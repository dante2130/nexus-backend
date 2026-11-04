// Select an auditable backend source-check plan from the GitHub event payload.
// Only an explicit [source-only] push HEAD commit message or pull request title
// selects the noncompiling plan. Everything else keeps the normal full checks.
//
// Event text is read only from GITHUB_EVENT_PATH. It is never interpolated into
// a workflow expression or a shell command, and only an allowlisted literal is
// written to stdout for GITHUB_OUTPUT.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const MODES = Object.freeze(['full', 'source-only']);
export const SOURCE_ONLY_MARKER = '[source-only]';
export const CONTRACT_DIRECTORY = 'scripts/ci';
export const NATIVE_REGRESSION = 'scripts/test-backend.mjs';
const CONTRACT_NAME = /^[a-z0-9._-]+\.test\.mjs$/;
// Direct compiler or toolchain invocations that would make a contract test
// unsuitable for the noncompiling source-only plan. A helper script that
// compiles internally still needs explicit review.
const INVOCATION = /(?:execFileSync|execFile|execSync|spawnSync|spawn)\s*\(\s*(['"`])([^'"`]+)\1/g;
const COMPILING_TOOLS = new Set([
  'cargo', 'rustc', 'rustup', 'npm', 'npx', 'pnpm', 'yarn', 'make', 'cmake',
  'ninja', 'cc', 'gcc', 'g++', 'clang', 'clang++', 'node-gyp',
]);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Only flat regular test files inside the reviewed contract directory.
export function assertContractPath(relative) {
  if (typeof relative !== 'string' || !relative.length)
    throw Error('Unsafe source contract path: ' + String(relative));
  if (relative !== relative.trim() || relative.includes('\\') || relative.includes('..') || path.posix.isAbsolute(relative))
    throw Error('Unsafe source contract path: ' + relative);
  const separator = relative.lastIndexOf('/');
  const directory = separator < 0 ? '' : relative.slice(0, separator);
  const name = relative.slice(separator + 1);
  if (directory !== CONTRACT_DIRECTORY || !CONTRACT_NAME.test(name))
    throw Error('Source contract path is outside ' + CONTRACT_DIRECTORY + ': ' + relative);
  return relative;
}

export async function enumerateContractTests(root = repository) {
  const directory = path.join(root, ...CONTRACT_DIRECTORY.split('/'));
  let entries;
  try {
    entries = await fs.readdir(directory, {withFileTypes: true});
  } catch (error) {
    throw Error('Missing source contract directory ' + CONTRACT_DIRECTORY + ': ' + error.message);
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.test.mjs')) continue;
    if (entry.isSymbolicLink())
      throw Error('Source contract test must be a regular file: ' + CONTRACT_DIRECTORY + '/' + entry.name);
    if (entry.isFile()) found.push(assertContractPath(CONTRACT_DIRECTORY + '/' + entry.name));
  }
  const files = Object.freeze([...new Set(found)].sort());
  if (!files.length) throw Error('No source contract test files were found');
  return files;
}

// Mirrors the existing workflow convention: a push reads only the pushed HEAD
// commit message, a pull request reads only its title. Any other event or a
// missing value stays on the normal full plan, so only an explicit marker can
// skip native coverage.
export function resolveMode({eventName, headCommitMessage, pullRequestTitle} = {}) {
  const marked = value => typeof value === 'string' && value.includes(SOURCE_ONLY_MARKER);
  if (eventName === 'push') return marked(headCommitMessage) ? 'source-only' : 'full';
  if (eventName === 'pull_request') return marked(pullRequestTitle) ? 'source-only' : 'full';
  return 'full';
}

// Reads the runner-provided event payload without any shell interpolation. A
// missing, unreadable or malformed context falls back to the normal full plan.
export async function readEventContext({eventName = process.env.GITHUB_EVENT_NAME, eventPath = process.env.GITHUB_EVENT_PATH} = {}) {
  const name = typeof eventName === 'string' ? eventName : '';
  if (name !== 'push' && name !== 'pull_request') return {eventName: 'other'};
  let payload;
  try {
    if (typeof eventPath !== 'string' || !eventPath) throw Error('Missing GITHUB_EVENT_PATH');
    payload = JSON.parse(await fs.readFile(eventPath, 'utf8'));
  } catch {
    return {eventName: name};
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {eventName: name};
  return {
    eventName: name,
    headCommitMessage: payload.head_commit && typeof payload.head_commit.message === 'string' ? payload.head_commit.message : undefined,
    pullRequestTitle: payload.pull_request && typeof payload.pull_request.title === 'string' ? payload.pull_request.title : undefined,
  };
}

export async function buildPlan({mode, files, root = repository} = {}) {
  if (!MODES.includes(mode)) throw Error('Unsupported source-check mode: ' + String(mode));
  const available = Object.freeze(files ? [...files] : await enumerateContractTests(root));
  const contracts = Object.freeze([...new Set(available.map(assertContractPath))].sort());
  if (!contracts.length) throw Error('No source contract test files were found');
  const skippedNative = mode === 'source-only' ? Object.freeze([NATIVE_REGRESSION]) : Object.freeze([]);
  return Object.freeze({mode, contracts, nativeRegression: NATIVE_REGRESSION, skippedNative});
}

// Second guard for a future contract test that starts compiling. It only
// detects direct compiler invocations, so the source-only plan stays honest
// about the limits of that check.
export async function assertNoCompilation(files, root = repository) {
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(root, ...assertContractPath(file).split('/')), 'utf8');
    for (const match of text.matchAll(INVOCATION)) {
      const tool = path.basename(match[2]);
      if (COMPILING_TOOLS.has(tool)) {
        offenders.push(file + ' (' + tool + ')');
        break;
      }
    }
  }
  if (offenders.length)
    throw Error('Source-only contracts contain compiling invocations: ' + offenders.join(', '));
}

export function planSummary(plan) {
  const lines = [
    'Source-check mode: ' + plan.mode,
    'Selected noncompiling source contract files: ' + plan.contracts.length,
  ];
  for (const file of plan.contracts) lines.push('  selected ' + file);
  if (plan.mode === 'source-only') {
    lines.push('Native regression NOT run and NOT passed: ' + plan.skippedNative.join(', '));
    lines.push('Skipped for this explicit [source-only] run: Rust toolchain, native test libraries, Rust cache and account-free cargo regression tests.');
    lines.push('Native regression coverage remains unverified by this run.');
  } else {
    lines.push('Native regression selected for the following step: ' + plan.nativeRegression);
    lines.push('Full checks include the Rust toolchain, native test libraries, Rust cache and account-free cargo regression tests.');
  }
  return lines;
}

async function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  await fs.appendFile(file, markdown.endsWith('\n') ? markdown : markdown + '\n');
}

export async function detectMode({eventName = process.env.GITHUB_EVENT_NAME, eventPath = process.env.GITHUB_EVENT_PATH} = {}) {
  const context = await readEventContext({eventName, eventPath});
  const mode = resolveMode(context);
  if (!MODES.includes(mode)) throw Error('Refusing to emit an unsupported source-check mode');
  return {mode, context};
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--detect-mode') {
    const {mode, context} = await detectMode();
    // Only this allowlisted literal reaches stdout, which the workflow appends
    // to GITHUB_OUTPUT. The raw event text is never printed.
    process.stdout.write('mode=' + mode + '\n');
    process.stderr.write('Source-check mode selected from the CI event (' + context.eventName + '): ' + mode + '\n');
    await writeSummary('Source-check mode selected from the CI event: ' + mode + '\n');
    return 0;
  }
  if (argv.length === 2 && argv[0] === '--run-contracts') {
    const plan = await buildPlan({mode: argv[1]});
    if (plan.mode === 'source-only') await assertNoCompilation(plan.contracts);
    const summary = planSummary(plan);
    for (const line of summary) console.log(line);
    await writeSummary(summary.join('\n') + '\n');
    const result = spawnSync(process.execPath, ['--test', ...plan.contracts], {cwd: repository, stdio: 'inherit'});
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  throw Error('Usage: source-check-plan.mjs --detect-mode | --run-contracts full|source-only');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  }
}
