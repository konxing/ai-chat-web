import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { dependenciesReady } = createRequire(import.meta.url)('../../scripts/windows/check-dependencies.cjs');
const fixtures: string[] = [];
function json(root: string, filename: string, value: unknown) {
  const destination = path.join(root, filename);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(value));
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwebchat-dependency-test-'));
  fixtures.push(root);
  const manifest = { name: 'dependency-check', version: '1.0.0', dependencies: { dep: '^1.0.0' }, devDependencies: { builder: '1.0.0' } };
  const packages = {
    '': manifest,
    'node_modules/dep': { version: '1.0.0', dependencies: { leaf: '^1.0.0' } },
    'node_modules/leaf': { version: '1.0.0' },
    'node_modules/builder': { version: '1.0.0', dev: true }
  };
  json(root, 'package.json', manifest);
  json(root, 'package-lock.json', { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages });
  const { '': omitted, ...installed } = packages;
  json(root, 'node_modules/.package-lock.json', { lockfileVersion: 3, packages: installed });
  for (const [location, metadata] of Object.entries(installed)) json(root, `${location}/package.json`, { name: path.basename(location), ...metadata });
  return root;
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Windows build dependency readiness', () => {
  it('accepts a complete installed tree without requiring an install stamp', () => {
    expect(dependenciesReady(fixture())).toBe(true);
  });
  it.each(['dep', 'leaf', 'builder'])('detects a missing %s even when the hidden lock remains', (name) => {
    const root = fixture();
    rmSync(path.join(root, 'node_modules', name), { recursive: true });
    expect(dependenciesReady(root)).toBe(false);
  });
  it('detects a transitive lock update even if the old version satisfies its range', () => {
    const root = fixture();
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/leaf'].version = '1.1.0';
    json(root, 'package-lock.json', lock);
    expect(dependenciesReady(root)).toBe(false);
  });
  it('detects a changed physical version despite stale installed metadata', () => {
    const root = fixture();
    json(root, 'node_modules/leaf/package.json', { name: 'leaf', version: '1.1.0' });
    expect(dependenciesReady(root)).toBe(false);
  });
  it('requires installation when manifests disagree or installed metadata is missing', () => {
    const root = fixture();
    json(root, 'package.json', { name: 'dependency-check', dependencies: { other: '1.0.0' } });
    expect(dependenciesReady(root)).toBe(false);
    rmSync(path.join(root, 'node_modules/.package-lock.json'));
    expect(dependenciesReady(root)).toBe(false);
  });
  it('checks actual peer requirements instead of trusting matching lock files', () => {
    const root = fixture();
    json(root, 'node_modules/dep/package.json', { name: 'dep', version: '1.0.0', peerDependencies: { missing: '^1.0.0' } });
    expect(dependenciesReady(root)).toBe(false);
  });
  it('allows absent optional platform packages', () => {
    const root = fixture();
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/platform-only'] = { version: '1.0.0', optional: true, os: ['unsupported-platform'] };
    json(root, 'package-lock.json', lock);
    expect(dependenciesReady(root)).toBe(true);
  });
  it('requires the command shim and entry file for installed build tools', () => {
    const root = fixture();
    for (const filename of ['package-lock.json', 'node_modules/.package-lock.json']) {
      const lock = JSON.parse(readFileSync(path.join(root, filename), 'utf8'));
      lock.packages['node_modules/builder'].bin = { builder: 'cli.js' };
      json(root, filename, lock);
    }
    expect(dependenciesReady(root)).toBe(false);
    mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules/.bin/builder' + (process.platform === 'win32' ? '.cmd' : '')), '');
    writeFileSync(path.join(root, 'node_modules/builder/cli.js'), '');
    expect(dependenciesReady(root)).toBe(true);
    rmSync(path.join(root, 'node_modules/builder/cli.js'));
    expect(dependenciesReady(root)).toBe(false);
  });
});
