import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FormRegistry, FormSyntaxError, findField, normalizeFormUrl, parseForm, resolveForm, resolveRegisteredForm } from '../src/index.ts';

void test('normalizes URL references without accessing the filesystem', () => {
  assert.equal(normalizeFormUrl('//wtv/base.xmd'), 'x-local://wtv/base.xmd');
  assert.equal(normalizeFormUrl('../base.xmd', 'x-local://wtv/sub/item.xmd'), 'x-local://wtv/sub/../base.xmd');
  assert.equal(normalizeFormUrl('x-app://app/library.xmd'), 'x-app://app/library.xmd');
  assert.equal(normalizeFormUrl('custom:registered'), 'custom:registered');
  assert.equal(normalizeFormUrl('x_key:registered'), 'x_key:registered');
  assert.equal(normalizeFormUrl('x-local://wtv/a/../base.xmd'), 'x-local://wtv/a/../base.xmd');
  assert.equal(normalizeFormUrl('', 'x-local://wtv/item.xmd'), 'x-local://wtv/');
  assert.throws(() => normalizeFormUrl('relative.xmd'), TypeError);
});

void test('parses ordinary and inline forms while preserving script source and duplicates', () => {
  const form = parseForm('<SPXML-INLINE-FORM><USE FORM="base.xmd"/><item><run METHOD="1" PARAM="a" PARAM="b" EXPR="return a &gt; b;"/></item></SPXML-INLINE-FORM>', 'x-local://wtv/item.xmd');
  assert.equal(form.inline, true);
  assert.deepEqual(form.uses, ['x-local://wtv/base.xmd']);
  assert.equal(form.elements.length, 1);
  assert.equal(parseForm('<root/>', form.url).elements.length, 0);
  assert.throws(() => parseForm('<SPXML-FORM><USE/></SPXML-FORM>', form.url), FormSyntaxError);
});

void test('resolves transitive imports, TYPE defaults, INHERIT insertion, and local child overrides', () => {
  const registry = new FormRegistry();
  registry.register('<SPXML-FORM><base SAMPLE="1"><name TYPE="string" DEFAULT="base"/><count TYPE="integer"/></base></SPXML-FORM>', 'x-local://wtv/base.xmd');
  registry.register('<SPXML-FORM><USE FORM="base.xmd"/><extended SAMPLE="1" TYPE="base"><flag TYPE="bool"/></extended></SPXML-FORM>', 'x-local://wtv/middle.xmd');
  const form = registry.register('<SPXML-FORM><USE FORM="middle.xmd"/><item TYPE="extended"><name DEFAULT="local"/><group><INHERIT TYPE="base" TEMP="1"/></group></item></SPXML-FORM>', 'x-local://wtv/item.xmd');
  const resolved = resolveForm(form, registry);
  assert.equal(resolved.kind, 'object');
  assert.ok(resolved.root);
  assert.deepEqual(resolved.root.children.map(field => field.name), ['name', 'count', 'flag', 'group']);
  const name = findField(resolved.root, 'item.name');
  assert.equal(name?.type, 'string');
  assert.equal(name.attrs['DEFAULT'], 'local');
  assert.equal(findField(resolved.root, 'item.group.name')?.attrs['TEMP'], undefined);
  assert.equal(findField(resolved.root, 'item.group.name')?.attributeSpans['DEFAULT']?.sourceName, 'x-local://wtv/base.xmd');
  assert.deepEqual(resolved.issues.map(issue => issue.code), ['REDEFINED_FIELD']);
  assert.deepEqual(resolved.root.templates, ['extended', 'base']);
  assert.equal(resolved.root.attrs['SAMPLE'], undefined);
});

void test('local templates shadow imports and self-INHERIT can extend the imported namesake', () => {
  const registry = new FormRegistry();
  registry.register('<SPXML-FORM><base SAMPLE="1"><first TYPE="string"/></base></SPXML-FORM>', 'x-local://wtv/base.xmd');
  const form = registry.register('<SPXML-FORM><USE FORM="base.xmd"/><base SAMPLE="1"><INHERIT TYPE="base"/><second TYPE="real"/></base><item TYPE="base"/></SPXML-FORM>', 'x-local://wtv/item.xmd');
  const resolved = resolveForm(form, registry);
  assert.deepEqual(resolved.root?.children.map(field => field.name), ['first', 'second']);
  assert.deepEqual(resolved.issues, []);
});

void test('missing imports and recursive templates return deterministic issues', () => {
  const registry = new FormRegistry();
  const form = registry.register('<SPXML-FORM><USE FORM="missing.xmd"/><base SAMPLE="1" TYPE="base"/><item><unknown TYPE="absent"/><INHERIT TYPE="absent"/></item></SPXML-FORM>', 'x-local://wtv/item.xmd');
  const result = resolveForm(form, registry);
  assert.deepEqual(new Set(result.issues.map(issue => issue.code)), new Set(['UNKNOWN_TYPE', 'UNKNOWN_INHERIT']));
  assert.deepEqual(resolveForm(form, registry).issues, result.issues);
  assert.throws(() => resolveRegisteredForm('x-local://wtv/missing.xmd', registry), /not registered/);
});

void test('import cycles and depth limits are bounded', () => {
  const registry = new FormRegistry();
  const first = registry.register('<SPXML-FORM><USE FORM="second.xmd"/><item><a><b/></a></item></SPXML-FORM>', 'x-local://wtv/first.xmd');
  registry.register('<SPXML-FORM><USE FORM="first.xmd"/></SPXML-FORM>', 'x-local://wtv/second.xmd');
  assert.deepEqual(resolveForm(first, registry).issues, []);
  assert.ok(resolveForm(first, registry, { maxDepth: 1 }).issues.some(issue => issue.code === 'DEPTH_LIMIT'));
});

void test('catalogs and libraries are classified without storage or runtime integration', () => {
  const registry = new FormRegistry();
  const catalog = registry.register('<SPXML-FORM CATALOG="1" OBJECT-NAME="item"><items><item MULTIPLE="1"><id TYPE="integer"/></item></items></SPXML-FORM>', 'x-local://wtv/items.xmd');
  assert.equal(resolveForm(catalog, registry).kind, 'catalog');
  const library = registry.register('<SPXML-FORM><sample SAMPLE="1"/><property PROPERTY="1"/><SHARE/></SPXML-FORM>', 'x-local://wtv/library.xmd');
  assert.equal(resolveForm(library, registry).kind, 'library');
  assert.equal(resolveForm(library, registry).root, null);
});

void test('registry replacements are visible immediately and resolution does not mutate raw forms', () => {
  const registry = new FormRegistry();
  registry.register('<SPXML-FORM><base SAMPLE="1"><old TYPE="string"/></base></SPXML-FORM>', 'x-local://wtv/base.xmd');
  const form = registry.register('<SPXML-FORM><USE FORM="base.xmd"/><item TYPE="base"/></SPXML-FORM>', 'x-local://wtv/item.xmd');
  const before = JSON.stringify(form);
  const old = resolveForm(form, registry);
  registry.register('<SPXML-FORM><base SAMPLE="1"><fresh TYPE="integer"/></base></SPXML-FORM>', 'x-local://wtv/base.xmd');
  assert.equal(resolveForm(form, registry).root?.children[0]?.name, 'fresh');
  assert.equal(old.root?.children[0]?.name, 'old');
  assert.equal(JSON.stringify(form), before);
  assert.equal(registry.remove('x-local://wtv/base.xmd'), true);
});

void test('cyclic USE preserves cross-form templates instead of dropping inherited fields', () => {
  const registry = new FormRegistry();
  const form = registry.register('<SPXML-FORM><USE FORM="b.xmd"/><base SAMPLE="1"><name TYPE="string"/></base><item TYPE="extended"/></SPXML-FORM>', 'x-local://app/a.xmd');
  registry.register('<SPXML-FORM><USE FORM="a.xmd"/><extended SAMPLE="1" TYPE="base"/></SPXML-FORM>', 'x-local://app/b.xmd');
  const result = resolveForm(form, registry);
  assert.deepEqual(result.root?.children.map(field => [field.name, field.type]), [['name', 'string']]);
  assert.deepEqual(result.root.templates, ['extended', 'base']);
  assert.deepEqual(result.issues, []);
});

void test('unused samples do not contaminate root diagnostics and unresolved self types are preserved', () => {
  const registry = new FormRegistry();
  const form = registry.register('<SPXML-FORM><unused SAMPLE="1" TYPE="missing"/><item TYPE="item"/></SPXML-FORM>', 'x-local://app/item.xmd');
  const result = resolveForm(form, registry);
  assert.equal(result.root?.type, 'item');
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.path, issue.detail]), [['UNKNOWN_TYPE', 'item', 'item']]);
  const library = registry.register('<SPXML-FORM><unused SAMPLE="1" TYPE="missing"/></SPXML-FORM>', 'x-local://app/library.xmd');
  assert.deepEqual(resolveForm(library, registry).issues, []);
});

void test('root diagnostics retain repeated redefinitions in declaration order', () => {
  const registry = new FormRegistry();
  const form = registry.register('<SPXML-FORM><item><name TYPE="string"/><name DEFAULT="a"/><name DEFAULT="b"/></item></SPXML-FORM>', 'x-local://app/item.xmd');
  const result = resolveForm(form, registry);
  assert.equal(result.root?.children[0]?.attrs['DEFAULT'], 'b');
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.path, issue.detail]), [['REDEFINED_FIELD', 'item/name', ''], ['REDEFINED_FIELD', 'item/name', '']]);
});