import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentXmlError, inferDocumentForm, parseDocumentXml, serializeDocumentXml } from '../src/document-xml.ts';
import { FormRegistry, resolveForm } from '../src/index.ts';

void test('document XML preserves data independently of the form parser', () => {
  const data = parseDocumentXml('<data label="A &amp; B"><name><![CDATA[<Example>]]></name><row>1</row><row>2</row></data>');
  assert.deepEqual(data.attributes, [['label', 'A & B']]);
  assert.equal(data.children[0]?.text, '<Example>');
  const xml = serializeDocumentXml(data);
  assert.match(xml, /label="A &amp; B"/);
  assert.match(xml, /&lt;Example&gt;/);
  assert.deepEqual(parseDocumentXml(xml), data);
});

void test('serialization supports document headers and form identity', () => {
  const data = parseDocumentXml('<item><name>Example</name></item>');
  const xml = serializeDocumentXml(data, {
    header: true,
    formUrl: 'x-local://app/item.xmd'
  });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\r\n'));
  assert.deepEqual(parseDocumentXml(xml).attributes, [['SPXML-FORM', 'x-local://app/item.xmd']]);
});

void test('schema inference merges repeated shapes without executing scripts', () => {
  const data = parseDocumentXml('<data><row><id>1</id></row><row><id>2</id><extra>yes</extra></row></data>');
  const form = inferDocumentForm(data, 'x-memory://documents/1.xmd');
  const resolved = resolveForm(form, new FormRegistry());
  assert.equal(resolved.issues.length, 0);
  const row = resolved.root?.children[0];
  assert.equal(row?.attrs['MULTIPLE'], '1');
  assert.deepEqual(row.children.map(child => [child.name, child.type]), [['id', 'string'], ['extra', 'string']]);
  assert.equal(form.url, 'x-memory://documents/1.xmd');
});

void test('malformed documents, declarations and depth failures use data XML errors', () => {
  for (const source of ['', '<item>', '<item>&unknown;</item>', '<item/><other/>', '<!DOCTYPE item SYSTEM "file:///secret"><item/>']) {
    assert.throws(() => parseDocumentXml(source), DocumentXmlError);
  }

  assert.throws(() => parseDocumentXml('<item/>trailing text'), DocumentXmlError);
  assert.throws(() => parseDocumentXml('<a><b><c/></b></a>', { maxDepth: 2 }), { code: 'DEPTH_LIMIT' });
  assert.throws(() => parseDocumentXml('<a/>', { maxDepth: 0 }), TypeError);
});