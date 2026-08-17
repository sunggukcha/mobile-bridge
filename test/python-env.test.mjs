import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import {
  applyPythonEnv,
  channelPythonExecutable,
  channelPythonVenvPath,
  comparePythonVersions,
  ensureChannelPythonVenv,
  prepareChannelPythonEnv,
  resetChannelPythonEnvCache,
  resolvePythonCandidates,
} from '../lib/python-env.mjs';

test('comparePythonVersions orders major minor and patch numbers', () => {
  assert.equal(comparePythonVersions([3, 13, 1], [3, 12, 9]) > 0, true);
  assert.equal(comparePythonVersions([3, 10, 14], [3, 10, 14]), 0);
  assert.equal(comparePythonVersions([3, 8, 10], [3, 10, 0]) < 0, true);
});

test('resolvePythonCandidates picks the highest available version', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-python-env-'));
  const python38 = await writeFakePython(temp, 'python3', '3.8.10');
  const python310 = await writeFakePython(temp, 'python', '3.10.14');
  const config = loadConfig({
    PROJECT_ROOT: path.join(temp, 'projects'),
    BRIDGE_PYTHON_CANDIDATES: `${python38},${python310}`,
  });

  const candidates = await resolvePythonCandidates(config);
  assert.equal(candidates[0].command, python310);
  assert.equal(candidates[0].versionText, 'Python 3.10.14');
  assert.equal(candidates[1].command, python38);
});

test('ensureChannelPythonVenv creates a channel shared virtualenv', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-python-env-'));
  const python = await writeFakePython(temp, 'python', '3.13.7');
  const stateRoot = path.join(temp, 'state');
  const config = loadConfig({
    PROJECT_ROOT: path.join(temp, 'projects'),
    BRIDGE_STATE_ROOT: stateRoot,
    BRIDGE_PYTHON_BIN: python,
    CHANNEL_PYTHON_VENV_AUTO_CREATE: 'true',
  });

  await ensureChannelPythonVenv(config, 'channel-1');

  const venvPath = channelPythonVenvPath(config, 'channel-1');
  const venvPython = channelPythonExecutable(config, 'channel-1');
  assert.equal(venvPath, path.join(stateRoot, 'channel-1_common', '.venv'));
  assert.equal(await readTrim(path.join(venvPath, 'pyvenv.cfg')), 'version = 3.13.7');
  assert.match(await fs.readFile(venvPython, 'utf8'), /Python 3\.13\.7/);
});

test('ensureChannelPythonVenv skips pip verification while the marker still matches', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-python-env-'));
  const python = await writeFakePython(temp, 'python', '3.13.7');
  const stateRoot = path.join(temp, 'state');
  const config = loadConfig({
    PROJECT_ROOT: path.join(temp, 'projects'),
    BRIDGE_STATE_ROOT: stateRoot,
    BRIDGE_PYTHON_BIN: python,
    CHANNEL_PYTHON_VENV_AUTO_CREATE: 'true',
  });

  await ensureChannelPythonVenv(config, 'channel-1');
  const afterCreate = await countMarks(path.join(stateRoot, 'channel-1_common', 'pip-probes.log'));
  assert.equal(afterCreate > 0, true);

  const venvPath = channelPythonVenvPath(config, 'channel-1');
  const marker = JSON.parse(await fs.readFile(path.join(venvPath, '.bridge-pip-verified.json'), 'utf8'));
  assert.equal(marker.pythonVersionText, 'Python 3.13.7');
  assert.deepEqual(marker.files.map((entry) => entry.path), [path.join(venvPath, 'bin', 'pip')]);

  await ensureChannelPythonVenv(config, 'channel-1');
  assert.equal(await countMarks(path.join(stateRoot, 'channel-1_common', 'pip-probes.log')), afterCreate);

  await fs.appendFile(path.join(venvPath, 'bin', 'pip'), '# reinstalled\n');
  await ensureChannelPythonVenv(config, 'channel-1');
  assert.equal(await countMarks(path.join(stateRoot, 'channel-1_common', 'pip-probes.log')) > afterCreate, true);
});

test('prepareChannelPythonEnv prepares each channel venv once per process', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-python-env-'));
  const python = await writeFakePython(temp, 'python', '3.13.7');
  const stateRoot = path.join(temp, 'state');
  const config = loadConfig({
    PROJECT_ROOT: path.join(temp, 'projects'),
    BRIDGE_STATE_ROOT: stateRoot,
    BRIDGE_PYTHON_BIN: python,
    CHANNEL_PYTHON_VENV_AUTO_CREATE: 'true',
  });
  resetChannelPythonEnvCache();

  const versionCalls = `${python}-version-calls.log`;
  const [first, second] = await Promise.all([
    prepareChannelPythonEnv(config, { channelId: 'channel-1' }),
    prepareChannelPythonEnv(config, { channelId: 'channel-1' }),
  ]);
  const afterConcurrent = await countMarks(versionCalls);
  assert.equal(first.pythonBin, channelPythonExecutable(config, 'channel-1'));
  assert.deepEqual(second, first);
  assert.equal(afterConcurrent, 1);

  const third = await prepareChannelPythonEnv(config, { channelId: 'channel-1' });
  assert.deepEqual(third, first);
  assert.equal(await countMarks(versionCalls), afterConcurrent);
  assert.equal(await countMarks(path.join(stateRoot, 'channel-1_common', 'pip-probes.log')) > 0, true);

  await prepareChannelPythonEnv(config, { channelId: 'channel-2' });
  assert.equal(await countMarks(versionCalls), afterConcurrent + 1);
});

test('prepareChannelPythonEnv does not advertise an optional venv after creation fails', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-python-env-'));
  const config = loadConfig({
    PROJECT_ROOT: path.join(temp, 'projects'),
    BRIDGE_STATE_ROOT: path.join(temp, 'state'),
    BRIDGE_PYTHON_CANDIDATES: path.join(temp, 'missing-python'),
    CHANNEL_PYTHON_VENV_AUTO_CREATE: 'true',
    CHANNEL_PYTHON_VENV_REQUIRED: 'false',
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const prepared = await prepareChannelPythonEnv(config, { channelId: 'channel-1' });
    assert.equal(prepared.venvPath, '');
    assert.equal(prepared.venvBinDir, '');
    assert.equal(prepared.pythonBin, '');
  } finally {
    console.warn = originalWarn;
  }
});

test('applyPythonEnv gives channel virtualenv PATH precedence', () => {
  const venvBinDir = path.join('/tmp', 'state', 'channel_common', '.venv', 'bin');
  const env = applyPythonEnv({
    PATH: ['/usr/bin', venvBinDir, '/bin'].join(path.delimiter),
    PYTHONHOME: '/bad/pythonhome',
  }, {
    python: {
      venvPath: path.dirname(venvBinDir),
      venvBinDir,
      pythonBin: path.join(venvBinDir, 'python'),
    },
  });

  assert.equal(env.PATH.split(path.delimiter)[0], venvBinDir);
  assert.equal(env.VIRTUAL_ENV, path.dirname(venvBinDir));
  assert.equal(env.PYTHON, path.join(venvBinDir, 'python'));
  assert.equal(env.PYTHON_BIN, path.join(venvBinDir, 'python'));
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal('PYTHONHOME' in env, false);
  assert.equal(env.PATH.split(path.delimiter).filter((entry) => entry === venvBinDir).length, 1);
});

test('applyPythonEnv exposes the bundled Korean image font to workers', () => {
  const env = applyPythonEnv({}, {});

  assert.match(env.BRIDGE_KOREAN_FONT_FILE, /NanumGothicCoding-Regular\.ttf$/);
  assert.equal(env.BRIDGE_KOREAN_FONT_FAMILY, 'Nanum Gothic Coding');
});

async function writeFakePython(root, name, version) {
  const file = path.join(root, name);
  await fs.writeFile(file, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    "import { appendFileSync } from 'node:fs';",
    "import path from 'node:path';",
    'const args = process.argv.slice(2);',
    `const version = ${JSON.stringify(version)};`,
    'if (args[0] === "--version") {',
    '  appendFileSync(`${import.meta.filename}-version-calls.log`, "1,");',
    '  console.log(`Python ${version}`);',
    '  process.exit(0);',
    '}',
    'if (args[0] === "-m" && args[1] === "venv") {',
    '  const venv = args.at(-1);',
    '  await fs.mkdir(path.join(venv, "bin"), { recursive: true });',
    '  await fs.writeFile(path.join(venv, "pyvenv.cfg"), `version = ${version}\\n`);',
    '  const venvPython = path.join(venv, "bin", "python");',
    '  await fs.writeFile(venvPython, [',
    '    "#!/usr/bin/env node",',
    '    `import { appendFileSync } from "node:fs";`,',
    '    `import path from "node:path";`,',
    '    `const args = process.argv.slice(2);`,',
    '    `if (args[0] === "--version") { console.log("Python ${version}"); process.exit(0); }`,',
    '    `if (args[0] === "-m" && args[1] === "pip" && args[2] === "--version") {`,',
    '    `  appendFileSync(path.join(import.meta.dirname, "..", "..", "pip-probes.log"), "1,");`,',
    '    `  console.log("pip 25.0");`,',
    '    `  process.exit(0);`,',
    '    `}`,',
    '    `process.exit(1);`,',
    '    "",',
    '  ].join("\\n"));',
    '  await fs.chmod(venvPython, 0o755);',
    '  await fs.writeFile(path.join(venv, "bin", "pip"), "#!/usr/bin/env sh\\nexec \\"$(dirname \\"$0\\")/python\\" -m pip \\"$@\\"\\n");',
    '  await fs.chmod(path.join(venv, "bin", "pip"), 0o755);',
    '  process.exit(0);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.chmod(file, 0o755);
  return file;
}

async function readTrim(file) {
  return (await fs.readFile(file, 'utf8')).trim();
}

async function countMarks(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split(',').filter(Boolean).length;
}
