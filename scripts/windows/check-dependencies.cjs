const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Check the installed tree against the lock, without downloading or changing files. */
function dependenciesReady(root) {
  try {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, ''));
    const manifest = read('package.json');
    const lock = read('package-lock.json');
    const installed = read('node_modules/.package-lock.json');
    if (!lock.packages?.[''] || !installed.packages) return false;
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const expected = lock.packages[''][group] ?? {};
      const current = manifest[group] ?? {};
      if (Object.keys(expected).length !== Object.keys(current).length ||
          Object.entries(expected).some(([name, version]) => current[name] !== version)) return false;
    }
    for (const [location, expected] of Object.entries(lock.packages)) {
      if (location && !expected.optional && !installed.packages[location]) return false;
    }
    for (const [location, actual] of Object.entries(installed.packages)) {
      const expected = lock.packages[location];
      if (!location.startsWith('node_modules/') || !expected || expected.link ||
          ['version', 'resolved', 'integrity', 'link'].some((key) => actual[key] !== expected[key])) return false;
      // The hidden lock can survive a deleted or manually replaced package.
      const physical = read(path.join(location, 'package.json'));
      if (physical.version !== expected.version) return false;
      for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const declarations = expected[group] ?? {};
        const current = physical[group] ?? {};
        if (Object.keys(declarations).length !== Object.keys(current).length ||
            Object.entries(declarations).some(([name, version]) => current[name] !== version)) return false;
      }
      for (const [name, target] of Object.entries(expected.bin ?? {})) {
        const directory = location.slice(0, location.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const shim = path.join(directory, '.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
        if (!fs.existsSync(path.join(root, location, target)) || !fs.existsSync(path.join(root, shim))) return false;
      }
    }
    // Also validate dependency/peer requirements against the physical tree.
    const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd ls --all --include=dev --json']
      : ['ls', '--all', '--include=dev', '--json'];
    const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: 'ignore', timeout: 60_000 });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

module.exports = { dependenciesReady };
if (require.main === module) process.exit(dependenciesReady(path.resolve(__dirname, '../..')) ? 0 : 1);
