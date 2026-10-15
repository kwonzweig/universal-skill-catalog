#!/usr/bin/env node
// Materialize the pinned upstream skill packages listed in catalog.json into a new directory.
// Usage: node scripts/materialize.mjs --output <new-directory> [--sources <comma-separated-ids>]
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOG = path.join(ROOT, 'catalog.json');
const CACHE_PREFIX = 'universal-skill-catalog-';

const SHA40 = /^[0-9a-f]{40}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[A-Za-z0-9]+)?$/i;
const FILE_MODES = new Set(['100644', '100755']);
// Names Windows cannot create as given: reserved characters (":" opens an NTFS alternate data stream),
// a trailing space or period (stripped, so the name aliases another) and device names, also with an
// extension. https://learn.microsoft.com/windows/win32/fileio/naming-a-file
const WINDOWS_UNSAFE_NAME = /[<>:"\\|?*\u0000-\u001f]|[ .]$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(\.|$)/i;

const KEYS = {
  catalog: ['version', 'sources'],
  source: ['id', 'repo', 'commit', 'license', 'skillPaths'],
  skillPath: ['path', 'name'],
};

export class MaterializeError extends Error {}

function fail(message) {
  throw new MaterializeError(message);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function checkKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has unknown field "${key}"`);
  }
}

// Repository-relative path: "." is the repository root; otherwise plain "/"-separated segments.
export function normalizeRepoPath(value, label = 'path') {
  if (typeof value !== 'string' || value === '') fail(`${label} must be a non-empty string`);
  if (value === '.') return '';
  checkRelativePath(value, label);
  return value;
}

function checkRelativePath(value, label) {
  // Rejects absolute, drive-letter, backslash, control-character and dot-segment paths.
  if (/[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail(`${label} is not a safe relative path: ${JSON.stringify(value)}`);
  }
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git') {
      fail(`${label} is not a safe relative path: ${JSON.stringify(value)}`);
    }
  }
}

const isPortableName = (name) => !WINDOWS_UNSAFE_NAME.test(name) && !WINDOWS_DEVICE_NAME.test(name);

// Runs before anything is written: every planned path must be creatable as named on Windows and must not
// alias another planned path on a case- or normalization-insensitive file system such as NTFS or APFS.
function checkOutputPaths(files) {
  const spellings = new Map();
  for (const file of files) {
    const segments = file.path.split('/');
    for (const [index, segment] of segments.entries()) {
      if (!isPortableName(segment)) fail(`output path is not portable to Windows: ${JSON.stringify(file.path)}`);
      // Directories end in "/", so a file and a directory spelled alike also collide.
      const exact = `${segments.slice(0, index + 1).join('/')}${index < segments.length - 1 ? '/' : ''}`;
      const key = exact.replace(/\/$/, '').normalize('NFC').toLowerCase();
      const previous = spellings.get(key);
      if (previous !== undefined && (previous !== exact || !exact.endsWith('/'))) {
        fail(`output paths collide: ${JSON.stringify(previous)} and ${JSON.stringify(exact)}`);
      }
      spellings.set(key, exact);
    }
  }
}

export function validateCatalog(catalog) {
  checkKeys(catalog, KEYS.catalog, 'catalog');
  if (catalog.version !== 1) fail('catalog.version must be 1');
  if (!Array.isArray(catalog.sources) || catalog.sources.length === 0) fail('catalog.sources must be a non-empty array');
  const ids = new Set();
  const names = new Map();
  for (const [index, source] of catalog.sources.entries()) {
    const label = `catalog.sources[${index}]`;
    checkKeys(source, KEYS.source, label);
    if (typeof source.id !== 'string' || !SOURCE_ID.test(source.id) || !isPortableName(source.id)) {
      fail(`${label}.id is invalid`);
    }
    if (ids.has(source.id)) fail(`duplicate source id "${source.id}"`);
    ids.add(source.id);
    if (typeof source.repo !== 'string' || !REPO.test(source.repo) || source.repo.endsWith('.')) {
      fail(`${label}.repo must be a GitHub "owner/name"`);
    }
    if (typeof source.commit !== 'string' || !SHA40.test(source.commit)) {
      fail(`${label}.commit must be a full 40-character lowercase hex SHA`);
    }
    if (typeof source.license !== 'string' || source.license.trim() === '') fail(`${label}.license is required`);
    if (!Array.isArray(source.skillPaths) || source.skillPaths.length === 0) fail(`${label}.skillPaths must be a non-empty array`);
    const paths = new Set();
    for (const [skillIndex, skill] of source.skillPaths.entries()) {
      const skillLabel = `${label}.skillPaths[${skillIndex}]`;
      checkKeys(skill, KEYS.skillPath, skillLabel);
      const repoPath = normalizeRepoPath(skill.path, `${skillLabel}.path`);
      if (paths.has(repoPath)) fail(`${skillLabel}.path is listed twice`);
      paths.add(repoPath);
      if (typeof skill.name !== 'string' || !SKILL_NAME.test(skill.name) || !isPortableName(skill.name)) {
        fail(`${skillLabel}.name is invalid`);
      }
      if (names.has(skill.name)) {
        fail(`skill name collision: "${skill.name}" in sources "${names.get(skill.name)}" and "${source.id}"`);
      }
      names.set(skill.name, source.id);
    }
  }
  return catalog;
}

export function selectSources(catalog, requested) {
  if (requested === undefined) return catalog.sources;
  const ids = requested.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) fail('--sources needs at least one source id');
  const known = new Set(catalog.sources.map((source) => source.id));
  for (const id of ids) {
    if (!known.has(id)) fail(`unknown source id "${id}"`);
  }
  if (new Set(ids).size !== ids.length) fail('--sources lists a source id twice');
  // Catalog order keeps the result independent of the order of --sources.
  return catalog.sources.filter((source) => ids.includes(source.id));
}

async function git(args, options = {}) {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'buffer',
    maxBuffer: 1 << 30,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    ...options,
  });
  return stdout;
}

function parseTree(buffer) {
  const entries = [];
  for (const record of buffer.toString('utf8').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    entries.push({ mode, type, oid, path: record.slice(tab + 1) });
  }
  return entries;
}

function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function readBlob(repoDir, entry, label) {
  if (entry.type !== 'blob' || !FILE_MODES.has(entry.mode)) {
    fail(`${label}: unsupported git entry ${entry.mode} ${entry.type} at ${JSON.stringify(entry.path)}`);
  }
  checkRelativePath(entry.path, `${label} entry`);
  const bytes = await git(['-C', repoDir, 'cat-file', 'blob', entry.oid]);
  if (gitBlobId(bytes) !== entry.oid) fail(`${label}: blob ${entry.oid} does not match its content`);
  return bytes;
}

// Fetches one pinned commit into the cache and returns the planned output files for its skills and licenses.
async function collectSource(source, cacheDir, repoUrl) {
  const repoDir = path.join(cacheDir, `${source.id}.git`);
  await git(['init', '--quiet', '--bare', repoDir]);
  await git(['-C', repoDir, 'fetch', '--quiet', '--no-tags', '--depth=1', repoUrl(source.repo), source.commit]);
  const resolved = (await git(['-C', repoDir, 'rev-parse', '--verify', `${source.commit}^{commit}`])).toString().trim();
  if (resolved !== source.commit) fail(`${source.id}: fetched commit ${resolved} does not match ${source.commit}`);
  const tree = parseTree(await git(['-C', repoDir, 'ls-tree', '-r', '-z', '--full-tree', source.commit]));

  const files = [];
  const licenseFiles = [];
  for (const entry of tree) {
    if (entry.path.includes('/') || !LICENSE_FILE.test(entry.path)) continue;
    const bytes = await readBlob(repoDir, entry, source.id);
    const outPath = `licenses/${source.id}/${entry.path}`;
    files.push({ path: outPath, bytes, executable: entry.mode === '100755' });
    licenseFiles.push({ path: outPath, source: entry.path, sha256: sha256(bytes) });
  }

  const skills = [];
  for (const skill of source.skillPaths) {
    const prefix = normalizeRepoPath(skill.path);
    const inside = tree.filter((entry) => prefix === '' || entry.path.startsWith(`${prefix}/`));
    const label = `${source.id}:${skill.path}`;
    if (!inside.some((entry) => entry.path === (prefix === '' ? 'SKILL.md' : `${prefix}/SKILL.md`))) {
      fail(`${label} has no SKILL.md at ${source.commit}`);
    }
    const skillFiles = [];
    for (const entry of inside) {
      const bytes = await readBlob(repoDir, entry, label);
      const relative = prefix === '' ? entry.path : entry.path.slice(prefix.length + 1);
      const outPath = `skills/${skill.name}/${relative}`;
      files.push({ path: outPath, bytes, executable: entry.mode === '100755' });
      skillFiles.push({ path: outPath, sha256: sha256(bytes) });
    }
    skills.push({ name: skill.name, path: skill.path, files: skillFiles });
  }
  return {
    files,
    receipt: { id: source.id, repo: source.repo, commit: source.commit, license: source.license, licenseFiles, skills },
  };
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

async function listTree(dir, base = '') {
  const found = [];
  for (const entry of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const relative = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listTree(dir, relative)));
    else found.push({ path: relative, regular: entry.isFile() });
  }
  return found;
}

async function outputState(output) {
  let stat;
  try {
    stat = await fs.lstat(output);
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) fail(`output must not be a symbolic link: ${output}`);
  if (!stat.isDirectory()) fail(`output exists and is not a directory: ${output}`);
  return (await fs.readdir(output)).length === 0 ? 'empty' : 'existing';
}

// An existing output is accepted only when it holds exactly the planned files with identical bytes.
async function compareExisting(output, files) {
  const planned = new Map(files.map((file) => [file.path, file.bytes]));
  const differences = [];
  for (const entry of await listTree(output)) {
    const bytes = planned.get(entry.path);
    if (!entry.regular) differences.push(`not a regular file: ${entry.path}`);
    else if (!bytes) differences.push(`unexpected file: ${entry.path}`);
    else if (!bytes.equals(await fs.readFile(path.join(output, entry.path)))) differences.push(`changed: ${entry.path}`);
    planned.delete(entry.path);
  }
  for (const missing of planned.keys()) differences.push(`missing: ${missing}`);
  return differences;
}

async function writeNewFiles(output, files) {
  for (const file of files) {
    const target = path.join(output, ...file.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
  }
}

// True when child is parent itself or lies inside it. Across Windows drives or UNC shares path.relative()
// returns an absolute path: the two locations then do not contain each other.
export function contains(parent, child, pathApi = path) {
  const relative = pathApi.relative(parent, child);
  if (relative === '') return true;
  return !(relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative));
}

// Resolves links in the existing part of an absolute path and keeps the missing rest as given.
async function realPathOf(target) {
  try {
    return await fs.realpath(target);
  } catch (error) {
    const parent = path.dirname(target);
    if (error.code !== 'ENOENT' || parent === target) throw error;
    return path.join(await realPathOf(parent), path.basename(target));
  }
}

export async function materialize({
  output,
  sources,
  catalogPath = DEFAULT_CATALOG,
  repoUrl = (repo) => `https://github.com/${repo}.git`,
}) {
  if (typeof output !== 'string' || output === '') fail('--output <new-directory> is required');
  const outputDir = path.resolve(output);
  const catalogBytes = await fs.readFile(catalogPath);
  let catalog;
  try {
    catalog = JSON.parse(catalogBytes.toString('utf8'));
  } catch (error) {
    fail(`catalog is not valid JSON: ${error.message}`);
  }
  validateCatalog(catalog);
  const selected = selectSources(catalog, sources);

  const state = await outputState(outputDir);
  if (state === 'existing') {
    try {
      await fs.access(path.join(outputDir, 'receipt.json'));
    } catch {
      fail(`output is not empty and has no receipt.json; nothing was changed: ${outputDir}`);
    }
  }

  const realOutput = await realPathOf(outputDir);
  const tmpRoot = await fs.realpath(os.tmpdir());
  const cacheDir = await fs.mkdtemp(path.join(tmpRoot, CACHE_PREFIX));
  if (contains(cacheDir, realOutput) || contains(realOutput, cacheDir)) {
    await fs.rm(cacheDir, { recursive: true, force: true });
    fail('output and the temporary cache directory must not contain each other');
  }

  try {
    const files = [];
    const receiptSources = [];
    for (const source of selected) {
      const collected = await collectSource(source, cacheDir, repoUrl);
      files.push(...collected.files);
      receiptSources.push(collected.receipt);
    }
    const receipt = { version: 1, catalog: { path: 'catalog.json', sha256: sha256(catalogBytes) }, sources: receiptSources };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    files.push({ path: 'catalog.json', bytes: catalogBytes });
    files.sort(byPath);
    const receiptFile = { path: 'receipt.json', bytes: receiptBytes };
    const planned = [...files, receiptFile];
    checkOutputPaths(planned);

    const summary = {
      output: outputDir,
      receiptSha256: sha256(receiptBytes),
      sources: selected.map((source) => source.id),
      skills: receiptSources.reduce((count, source) => count + source.skills.length, 0),
      files: planned.length,
    };

    if (state === 'existing') {
      const differences = await compareExisting(outputDir, planned);
      if (differences.length > 0) {
        const shown = differences.slice(0, 10).join('; ');
        fail(`output differs from this result; nothing was changed (${differences.length} differences: ${shown})`);
      }
      return { status: 'unchanged', ...summary };
    }

    await fs.mkdir(outputDir, { recursive: true });
    // Exclusive creation never overwrites. receipt.json is written only after every other file reads back
    // unchanged, so its presence marks a complete, verified result.
    await writeNewFiles(outputDir, files);
    let differences = await compareExisting(outputDir, files);
    if (differences.length === 0) {
      await writeNewFiles(outputDir, [receiptFile]);
      differences = await compareExisting(outputDir, planned);
    }
    if (differences.length > 0) fail(`readback failed: ${differences.slice(0, 10).join('; ')}`);
    return { status: 'created', ...summary };
  } finally {
    if (path.basename(cacheDir).startsWith(CACHE_PREFIX) && path.dirname(cacheDir) === tmpRoot) {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  }
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split(/=(.*)/s, 2);
    if (flag !== '--output' && flag !== '--sources') fail(`unknown argument: ${argv[index]}`);
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') fail(`${flag} needs a value`);
    const key = flag.slice(2);
    if (key in args) fail(`${flag} given twice`);
    args[key] = value;
  }
  if (!args.output) fail('usage: node scripts/materialize.mjs --output <new-directory> [--sources <comma-separated-ids>]');
  return { output: args.output, sources: args.sources === undefined ? undefined : args.sources.split(',') };
}

async function main() {
  const result = await materialize(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = error instanceof MaterializeError ? error.message : error.stack || String(error);
    process.stderr.write(`materialize: ${message}\n`);
    process.exitCode = 1;
  });
}
