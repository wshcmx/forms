import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

interface PackEntry {
  filename: string;
  files: { path: string }[];
}

interface InstalledPackage {
  dependencies?: Record<string, string>;
}

function isPackEntry(value: unknown): value is PackEntry {
  return typeof value === 'object' && value !== null &&
    'filename' in value && typeof value.filename === 'string' &&
    'files' in value && Array.isArray(value.files) &&
    value.files.every((file: unknown) => typeof file === 'object' && file !== null &&
      'path' in file && typeof file.path === 'string');
}

function isInstalledPackage(value: unknown): value is InstalledPackage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return !('dependencies' in value) || value.dependencies === undefined ||
    (typeof value.dependencies === 'object' && value.dependencies !== null &&
      Object.values(value.dependencies).every((dependency: unknown) => typeof dependency === 'string'));
}

const root = dirname(import.meta.dirname);
const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const npmExecPath = process.env['npm_execpath'];
const npmCli = npmExecPath?.endsWith('npm-cli.js')
  ? npmExecPath
  : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

function runNpm(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

void describe('packed package', () => {
  let temporary: string | undefined;
  let consumer: string;
  let entry: PackEntry;

  before(() => {
    temporary = mkdtempSync(join(tmpdir(), 'forms-consumer-'));
    execFileSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.json')], {
      cwd: root,
      encoding: 'utf8'
    });
    const packed: unknown = JSON.parse(runNpm(['pack', root, '--pack-destination', temporary, '--json', '--ignore-scripts', '--workspaces=false'], temporary));
    const candidates = Array.isArray(packed)
      ? packed
      : typeof packed === 'object' && packed !== null
        ? Object.values(packed)
        : [];
    const entries = candidates.filter(isPackEntry);
    assert.equal(entries.length, 1);
    const selected = entries[0];
    assert.ok(selected);
    entry = selected;
    const tarball = join(temporary, entry.filename);
    consumer = join(temporary, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'forms-consumer',
      private: true,
      type: 'module'
    }));
    runNpm(['install', tarball, '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false'], consumer);
  });

  after(() => {
    if (temporary) {
      rmSync(temporary, {
        recursive: true,
        force: true
      });
    }
  });

  void test('excludes source and test files from the tarball', () => {
    assert.ok(entry.files.every(file => !file.path.includes('.test.') && !file.path.startsWith('src/')));
  });

  void test('supports an installed JavaScript consumer', () => {
    writeFileSync(join(consumer, 'consumer.js'), `
import assert from 'node:assert/strict';
import { FormRegistry, resolveForm, parseXml } from '@wshcmx/forms';
import { parseDocumentXml, serializeDocumentXml, inferDocumentForm } from '@wshcmx/forms/documents';
const registry = new FormRegistry();
registry.register('<SPXML-FORM><base SAMPLE="1"><name TYPE="string"/></base></SPXML-FORM>', 'x-local://app/base.xmd');
const form = registry.register('<SPXML-FORM><USE FORM="base.xmd"/><item TYPE="base"/></SPXML-FORM>', 'x-local://app/item.xmd');
const result = resolveForm(form, registry);
assert.equal(result.root.children[0].type, 'string');
assert.equal(result.issues.length, 0);
assert.equal(parseXml('<root PARAM="a" PARAM="b"/>').attrs['PARAM'], 'a,b');
const data = parseDocumentXml('<data><row>1</row><row>2</row></data>');
assert.deepEqual(parseDocumentXml(serializeDocumentXml(data)), data);
const inferred = inferDocumentForm(data, 'x-memory://documents/1.xmd', registry);
assert.equal(registry.getForm(inferred.url), inferred);
assert.equal(resolveForm(inferred, registry).root.children[0].attrs.MULTIPLE, '1');
`);
    execFileSync(process.execPath, [join(consumer, 'consumer.js')], {
      cwd: consumer,
      encoding: 'utf8'
    });
  });

  void test('supports an installed TypeScript consumer', () => {
    writeFileSync(join(consumer, 'consumer.ts'), `
import { FormRegistry, resolveForm, type Field, type FormProvider, type SourceSpan } from '@wshcmx/forms';
import { parseDocumentXml, serializeDocumentXml, inferDocumentForm, type DocumentNode, type DocumentSerializeOptions } from '@wshcmx/forms/documents';
const registry: FormProvider = new FormRegistry();
const form = registry.getForm('x-local://app/item.xmd');
if (form) {
  const root: Field | null = resolveForm(form, registry).root;
  const span: SourceSpan | undefined = root?.span;
  console.log(span);
}
const data: DocumentNode = parseDocumentXml('<data/>');
const options: DocumentSerializeOptions = { header: true };
const inferred = inferDocumentForm(data, 'x-memory://documents/1.xmd');
console.log(serializeDocumentXml(data, options), inferred);
`);
    execFileSync(process.execPath, [compiler, '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2024', join(consumer, 'consumer.ts')], {
      cwd: consumer,
      encoding: 'utf8'
    });
  });

  void test('depends only on the data XML parser, not the script runtime or language parser', () => {
    const installed: unknown = JSON.parse(readFileSync(join(consumer, 'node_modules/@wshcmx/forms/package.json'), 'utf8'));
    assert.ok(isInstalledPackage(installed));
    assert.deepEqual(Object.keys(installed.dependencies ?? {}), ['fast-xml-parser']);
  });
});