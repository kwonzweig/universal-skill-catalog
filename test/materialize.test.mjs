import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { contains, materialize } from '../scripts/materialize.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../scripts/materialize.mjs', import.meta.url));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

let root;
let repos;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => run('git', args, { cwd, env: GIT_ENV });
const gitInput = (cwd, args, input) => new Promise((resolve, reject) => {
  const child = execFile('git', args, { cwd, env: GIT_ENV }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
  child.stdin.end(input);
});
const repoUrl = (repo) => pathToFileURL(path.join(root, 'repos', repo.replace('/', '__'))).href;

const ALPHA = {
  'SKILL.md': '---\nname: alpha\n---\nRoot package. See [ref](docs/ref.md).\n',
  'LICENSE': 'MIT License (alpha)\n',
  'docs/ref.md': 'alpha reference\n',
  'scripts/run.sh': '#!/bin/sh\necho never executed\n',
};
const BETA = {
  'LICENSE': 'MIT License (beta)\n',
  'NOTICE': 'beta notice\n',
  'README.md': 'not a license file\n',
  'skills/one/SKILL.md': '---\nname: one\n---\nUses refs/a.md.\n',
  'skills/one/refs/a.md': 'one reference\n',
  'skills/two/SKILL.md': '---\nname: two\n---\n',
  'tools/unrelated.txt': 'outside every skill path\n',
};
// Each package holds a name that Windows cannot create as given, or two names that a case- or
// normalization-insensitive file system stores as one.
const HOSTILE = {
  'ads': ['plain.txt:stream'],
  'device': ['CON'],
  'device-extension': ['nul.tar.gz'],
  'device-superscript': ['COM\u00b9.md'],
  'trailing-period': ['notes.'],
  'trailing-space': ['docs /a.md'],
  'reserved-character': ['why?.md'],
  'case': ['A.txt', 'a.txt'],
  'case-directory': ['Docs/a.md', 'docs/b.md'],
  'case-file-directory': ['notes', 'NOTES/a.md'],
  'normalization': ['\u00e9.md', 'e\u0301.md'],
};

async function makeRepo(name, files, extra = async () => {}) {
  const dir = path.join(root, 'repos', name.replace('/', '__'));
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '--quiet', '--initial-branch=main');
  await git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
  await git(dir, 'add', '-A');
  await extra(dir);
  await git(dir, 'commit', '--quiet', '-m', 'fixture');
  return (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
}

// Builds the commit from git objects only, so it can hold paths that this host cannot create as files.
async function makeObjectRepo(name, files) {
  const dir = path.join(root, 'repos', name.replace('/', '__'));
  await git(root, 'init', '--quiet', '--bare', dir);
  await git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const tree = {};
  for (const [file, content] of Object.entries(files)) {
    const parts = file.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = content;
  }
  const writeTree = async (node) => {
    let listing = '';
    for (const [entry, value] of Object.entries(node)) {
      listing += typeof value === 'string'
        ? `100644 blob ${await gitInput(dir, ['hash-object', '-w', '--stdin'], value)}\t${entry}\0`
        : `040000 tree ${await writeTree(value)}\t${entry}\0`;
    }
    return gitInput(dir, ['mktree', '-z'], listing);
  };
  const commit = await gitInput(dir, ['commit-tree', await writeTree(tree)], 'fixture\n');
  await git(dir, 'update-ref', 'refs/heads/main', commit);
  return commit;
}

async function writeCatalog(name, sources) {
  const file = path.join(root, `${name}.json`);
  await fs.writeFile(file, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`);
  return file;
}

const alphaSource = () => ({
  id: 'alpha', repo: 'fixture/alpha', commit: repos.alpha, license: 'MIT', skillPaths: [{ path: '.', name: 'alpha' }],
});
const betaSource = () => ({
  id: 'beta',
  repo: 'fixture/beta',
  commit: repos.beta,
  license: 'MIT',
  skillPaths: [{ path: 'skills/one', name: 'one' }, { path: 'skills/two', name: 'two' }],
});

async function listFiles(dir, base = '') {
  const out = [];
  for (const entry of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, relative)));
    else out.push(relative);
  }
  return out.sort();
}

const outputDir = (name) => path.join(root, 'out', name);

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pas-test-'));
  repos = {
    alpha: await makeRepo('fixture/alpha', ALPHA, (dir) => git(dir, 'update-index', '--chmod=+x', 'scripts/run.sh')),
    beta: await makeRepo('fixture/beta', BETA),
  };
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('materializes unchanged packages, licenses, catalog and a hash receipt', async () => {
  const catalogPath = await writeCatalog('full', [alphaSource(), betaSource()]);
  const output = outputDir('full');
  const result = await materialize({ output, catalogPath, repoUrl });
  assert.equal(result.status, 'created');
  assert.deepEqual(result.sources, ['alpha', 'beta']);
  assert.equal(result.skills, 3);

  const expected = {
    'catalog.json': await fs.readFile(catalogPath, 'utf8'),
    'licenses/alpha/LICENSE': ALPHA.LICENSE,
    'licenses/beta/LICENSE': BETA.LICENSE,
    'licenses/beta/NOTICE': BETA.NOTICE,
    'skills/one/SKILL.md': BETA['skills/one/SKILL.md'],
    'skills/one/refs/a.md': BETA['skills/one/refs/a.md'],
    'skills/two/SKILL.md': BETA['skills/two/SKILL.md'],
  };
  for (const [file, content] of Object.entries(ALPHA)) expected[`skills/alpha/${file}`] = content;
  assert.deepEqual(await listFiles(output), [...Object.keys(expected), 'receipt.json'].sort());
  for (const [file, content] of Object.entries(expected)) {
    assert.equal(await fs.readFile(path.join(output, file), 'utf8'), content, file);
  }
  if (process.platform !== 'win32') {
    // Windows has no execute bit. Elsewhere the upstream modes 100755 and 100644 are kept.
    assert.equal((await fs.stat(path.join(output, 'skills/alpha/scripts/run.sh'))).mode & 0o100, 0o100);
    assert.equal((await fs.stat(path.join(output, 'skills/alpha/SKILL.md'))).mode & 0o111, 0);
  }

  const receiptBytes = await fs.readFile(path.join(output, 'receipt.json'));
  assert.equal(sha256(receiptBytes), result.receiptSha256);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.catalog.sha256, sha256(await fs.readFile(catalogPath)));
  assert.deepEqual(receipt.sources.map((s) => [s.id, s.repo, s.commit]), [
    ['alpha', 'fixture/alpha', repos.alpha],
    ['beta', 'fixture/beta', repos.beta],
  ]);
  const hashed = receipt.sources.flatMap((s) => [...s.licenseFiles, ...s.skills.flatMap((k) => k.files)]);
  assert.equal(hashed.length + 2, Object.keys(expected).length + 1);
  for (const file of hashed) {
    assert.equal(file.sha256, sha256(await fs.readFile(path.join(output, file.path))), file.path);
  }
  assert.deepEqual(receipt.sources[1].skills.map((k) => [k.name, k.path]), [['one', 'skills/one'], ['two', 'skills/two']]);
});

test('--sources selects a subset in catalog order', async () => {
  const catalogPath = await writeCatalog('subset', [alphaSource(), betaSource()]);
  const output = outputDir('subset');
  const result = await materialize({ output, catalogPath, repoUrl, sources: ['beta'] });
  assert.deepEqual(result.sources, ['beta']);
  assert.deepEqual(await listFiles(output), [
    'catalog.json', 'licenses/beta/LICENSE', 'licenses/beta/NOTICE', 'receipt.json',
    'skills/one/SKILL.md', 'skills/one/refs/a.md', 'skills/two/SKILL.md',
  ]);
  const receipt = JSON.parse(await fs.readFile(path.join(output, 'receipt.json')));
  assert.deepEqual(receipt.sources.map((s) => s.id), ['beta']);
});

test('an identical rerun is a verified no-op', async () => {
  const catalogPath = await writeCatalog('rerun', [alphaSource(), betaSource()]);
  const output = outputDir('rerun');
  const first = await materialize({ output, catalogPath, repoUrl, sources: ['beta', 'alpha'] });
  const before = await fs.stat(path.join(output, 'receipt.json'));
  const second = await materialize({ output, catalogPath, repoUrl, sources: ['alpha', 'beta'] });
  assert.equal(second.status, 'unchanged');
  assert.equal(second.receiptSha256, first.receiptSha256);
  assert.equal((await fs.stat(path.join(output, 'receipt.json'))).mtimeMs, before.mtimeMs);
});

test('changed, extra or differently selected output fails and is preserved', async () => {
  const catalogPath = await writeCatalog('edited', [alphaSource(), betaSource()]);
  const output = outputDir('edited');
  await materialize({ output, catalogPath, repoUrl });
  const edited = path.join(output, 'skills/one/SKILL.md');
  await fs.writeFile(edited, 'user edit\n');
  await assert.rejects(materialize({ output, catalogPath, repoUrl }), /changed: skills\/one\/SKILL\.md/);
  assert.equal(await fs.readFile(edited, 'utf8'), 'user edit\n');

  await fs.writeFile(edited, BETA['skills/one/SKILL.md']);
  const extra = path.join(output, 'skills/one/my-notes.md');
  await fs.writeFile(extra, 'mine\n');
  await assert.rejects(materialize({ output, catalogPath, repoUrl }), /unexpected file: skills\/one\/my-notes\.md/);
  assert.equal(await fs.readFile(extra, 'utf8'), 'mine\n');

  await fs.rm(extra);
  await assert.rejects(materialize({ output, catalogPath, repoUrl, sources: ['beta'] }), /differs/);
  assert.equal((await materialize({ output, catalogPath, repoUrl })).status, 'unchanged');
});

test('a non-empty directory without a receipt is rejected untouched', async () => {
  const catalogPath = await writeCatalog('foreign', [betaSource()]);
  const output = outputDir('foreign');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'keep.txt'), 'keep\n');
  await assert.rejects(materialize({ output, catalogPath, repoUrl }), /not empty/);
  assert.deepEqual(await listFiles(output), ['keep.txt']);
});

test('an empty existing directory is accepted', async () => {
  const catalogPath = await writeCatalog('empty', [betaSource()]);
  const output = outputDir('empty');
  await fs.mkdir(output, { recursive: true });
  assert.equal((await materialize({ output, catalogPath, repoUrl })).status, 'created');
});

test('rejects skill name collisions before writing', async () => {
  const clash = { ...alphaSource(), skillPaths: [{ path: '.', name: 'one' }] };
  const catalogPath = await writeCatalog('collision', [clash, betaSource()]);
  const output = outputDir('collision');
  await assert.rejects(materialize({ output, catalogPath, repoUrl }), /skill name collision: "one"/);
  await assert.rejects(fs.access(output));
});

test('rejects invalid commits, unknown sources and unknown fields', async () => {
  const output = outputDir('invalid');
  for (const commit of ['abc123', repos.beta.toUpperCase(), `${repos.beta}0`]) {
    const catalogPath = await writeCatalog('bad-sha', [{ ...betaSource(), commit }]);
    await assert.rejects(materialize({ output, catalogPath, repoUrl }), /full 40-character/);
  }
  const missing = await writeCatalog('missing-sha', [{ ...betaSource(), commit: 'f'.repeat(40) }]);
  await assert.rejects(materialize({ output, catalogPath: missing, repoUrl }));
  const good = await writeCatalog('good', [betaSource()]);
  await assert.rejects(materialize({ output, catalogPath: good, repoUrl, sources: ['nope'] }), /unknown source id "nope"/);
  const extraField = await writeCatalog('extra-field', [{ ...betaSource(), ref: 'main' }]);
  await assert.rejects(materialize({ output, catalogPath: extraField, repoUrl }), /unknown field "ref"/);
  await assert.rejects(fs.access(output));
});

test('rejects unsafe skill paths, skill names and source ids', async () => {
  const output = outputDir('unsafe');
  for (const bad of ['../x', '/x', 'a/../b', 'a\\b', 'C:/x', '.git/hooks', 'skills//one', './skills/one', '']) {
    const catalogPath = await writeCatalog('unsafe-path', [{ ...betaSource(), skillPaths: [{ path: bad, name: 'one' }] }]);
    await assert.rejects(materialize({ output, catalogPath, repoUrl }), /path/, JSON.stringify(bad));
  }
  for (const bad of ['../one', 'One', 'a/b', '.hidden', 'con', 'nul.md', 'aux.tar.gz', 'com1', 'one.']) {
    const catalogPath = await writeCatalog('unsafe-name', [{ ...betaSource(), skillPaths: [{ path: 'skills/one', name: bad }] }]);
    await assert.rejects(materialize({ output, catalogPath, repoUrl }), /name is invalid/, bad);
  }
  for (const bad of ['nul', 'lpt1']) {
    const catalogPath = await writeCatalog('unsafe-id', [{ ...betaSource(), id: bad }]);
    await assert.rejects(materialize({ output, catalogPath, repoUrl }), /id is invalid/, bad);
  }
  await assert.rejects(fs.access(output));
});

test('rejects Windows-unsafe names and case- or normalization-equivalent paths before writing', async () => {
  const files = {};
  for (const [skill, names] of Object.entries(HOSTILE)) {
    files[`skills/${skill}/SKILL.md`] = `---\nname: ${skill}\n---\n`;
    for (const name of names) files[`skills/${skill}/${name}`] = `${name}\n`;
  }
  const commit = await makeObjectRepo('fixture/hostile', files);
  const output = outputDir('hostile');
  for (const [skill, names] of Object.entries(HOSTILE)) {
    const catalogPath = await writeCatalog(`hostile-${skill}`, [{
      id: 'hostile', repo: 'fixture/hostile', commit, license: 'MIT', skillPaths: [{ path: `skills/${skill}`, name: skill }],
    }]);
    const expected = names.length > 1 ? /output paths collide/ : /not portable to Windows/;
    await assert.rejects(materialize({ output, catalogPath, repoUrl }), expected, skill);
  }
  await assert.rejects(fs.access(output));
});

test('a readback failure leaves no receipt', async (t) => {
  const catalogPath = await writeCatalog('readback', [betaSource()]);
  const output = outputDir('readback');
  const { writeFile } = fs;
  // Simulates a file system that stores different bytes than were written.
  t.mock.method(fs, 'writeFile', (target, bytes, options) =>
    writeFile(target, String(target).endsWith('SKILL.md') ? 'altered\n' : bytes, options));
  await assert.rejects(materialize({ output, catalogPath, repoUrl }), /readback failed: .*changed: skills\/one\/SKILL\.md/);
  await fs.access(path.join(output, 'catalog.json'));
  await assert.rejects(fs.access(path.join(output, 'receipt.json')));
});

test('the cache containment check is per drive and by path segment', () => {
  // Across Windows drives or shares path.relative() returns an absolute path, which is not containment.
  assert.equal(contains('C:\\Temp\\cache', 'D:\\newoutput', path.win32), false);
  assert.equal(contains('D:\\newoutput', 'C:\\Temp\\cache', path.win32), false);
  assert.equal(contains('C:\\Temp\\cache', '\\\\wsl.localhost\\Ubuntu\\out', path.win32), false);
  assert.equal(contains('C:\\Temp', 'c:\\temp\\cache', path.win32), true);
  assert.equal(contains('/tmp/cache', '/tmp/cache', path.posix), true);
  assert.equal(contains('/tmp/cache', '/tmp/cache/..out', path.posix), true);
  assert.equal(contains('/tmp/cache', '/tmp/cache-out', path.posix), false);
  assert.equal(contains('/tmp/cache/out', '/tmp/cache', path.posix), false);
});

test('rejects an output that is the temporary directory, also through a link', async () => {
  const realParent = path.join(root, 'tmp-real');
  const tmp = path.join(realParent, 'tmp');
  const linkParent = path.join(root, 'tmp-link');
  await fs.mkdir(tmp, { recursive: true });
  await fs.symlink(realParent, linkParent, 'junction');
  const catalogPath = await writeCatalog('contain', [betaSource()]);
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  Object.assign(process.env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  try {
    for (const output of [tmp, path.join(linkParent, 'tmp')]) {
      await assert.rejects(materialize({ output, catalogPath, repoUrl }), /must not contain each other/, output);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('rejects symlinks, submodules and missing SKILL.md in a package', async () => {
  const symlinked = await makeRepo('fixture/symlink', { 'skills/s/SKILL.md': 'x\n' }, async (dir) => {
    await fs.symlink('../../../../etc/passwd', path.join(dir, 'skills/s/escape'));
    await git(dir, 'add', '-A');
  });
  const submodule = await makeRepo('fixture/submodule', { 'skills/s/SKILL.md': 'x\n' }, (dir) =>
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${repos.beta},skills/s/vendored`));
  const output = outputDir('entries');
  const cases = [
    [{ id: 'link', repo: 'fixture/symlink', commit: symlinked, license: 'MIT', skillPaths: [{ path: 'skills/s', name: 's' }] }, /unsupported git entry 120000/],
    [{ id: 'sub', repo: 'fixture/submodule', commit: submodule, license: 'MIT', skillPaths: [{ path: 'skills/s', name: 's' }] }, /unsupported git entry 160000/],
    [{ ...betaSource(), skillPaths: [{ path: 'tools', name: 'tools' }] }, /no SKILL\.md/],
  ];
  for (const [source, pattern] of cases) {
    const catalogPath = await writeCatalog(`entry-${source.id}`, [source]);
    await assert.rejects(materialize({ output, catalogPath, repoUrl }), pattern);
  }
  await assert.rejects(fs.access(output));
});

test('the CLI reports argument errors without writing', async () => {
  const output = outputDir('cli');
  const attempts = [[], ['--output'], ['--output', output, '--sources', 'nope'], ['--output', output, '--force']];
  for (const args of attempts) {
    await assert.rejects(run(process.execPath, [CLI, ...args]), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^materialize: /);
      return true;
    });
  }
  await assert.rejects(fs.access(output));
});

test('the shipped catalog lists exactly the five selected sources', async () => {
  const catalog = JSON.parse(await fs.readFile(fileURLToPath(new URL('../catalog.json', import.meta.url))));
  assert.deepEqual(catalog.sources.map((s) => [s.id, s.repo]), [
    ['humanizer', 'blader/humanizer'],
    ['superpowers', 'obra/superpowers'],
    ['karpathy-guidelines', 'multica-ai/andrej-karpathy-skills'],
    ['tiatft-find-tools', 'kwonzweig/there-is-a-tool-for-that'],
    ['vercel-find-skills', 'vercel-labs/skills'],
  ]);
});
