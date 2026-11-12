import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml, FormSyntaxError } from '../src/index.ts';

void test('SPXML entities and repeated attributes retain their order while text and CDATA are ignored', () => {
  const root = parseXml('<?xml version="1.0"?><root PARAM="first" PARAM="second" EXPR="a &gt; 1"><!-- comment -->text<![CDATA[<raw>]]><child/></root>');
  assert.equal(root.attrs['PARAM'], 'first,second');
  assert.equal(root.attrs['EXPR'], 'a > 1');
  assert.deepEqual(root.attributes.map(attribute => attribute.value), ['first', 'second', 'a > 1']);
  assert.deepEqual(root.children.map(child => child.kind), ['element']);
});

void test('attribute value locations refer to the original source, including repeated names', () => {
  const source = '<root\r\n PARAM="first" PARAM="second" EXPR="return 1;"/>';
  const root = parseXml(source, {
    sourceName: 'sample.xmd',
    firstLine: 10
  });

  for (const attribute of root.attributes) {
    assert.equal(source.slice(attribute.valueSpan.start.offset, attribute.valueSpan.end.offset), attribute.value);
    assert.equal(attribute.valueSpan.start.line, 11);
    assert.equal(attribute.valueSpan.sourceName, 'sample.xmd');
  }

  assert.equal(root.span.end.offset, source.length);
});

void test('malformed XML fails deterministically without executing or loading declarations', () => {
  for (const source of ['', '<root>', '<root></wrong>', '<!--', '<![CDATA[', '<?xml', '<root a="unfinished>', '</root>', '<>', '<root></root></root>', '<root a="&#1114112;"/>']) {
    assert.throws(() => parseXml(source), FormSyntaxError, source);
  }

  assert.equal(parseXml('<!DOCTYPE root SYSTEM "file:///secret"><root/>').name, 'root');
  assert.throws(() => parseXml('<!DOCTYPE root'), FormSyntaxError);
  assert.throws(() => parseXml('<a><b><c/></b></a>', { maxDepth: 2 }), { code: 'DEPTH_LIMIT' });
  assert.throws(() => parseXml('<a/>', { firstLine: 0 }), RangeError);
});

void test('special attribute names cannot mutate object prototypes', () => {
  const root = parseXml('<root __proto__="safe" constructor="value"/>');
  assert.equal(root.attrs['__proto__'], 'safe');
  assert.equal(Object.getPrototypeOf(root.attrs), null);
});

void test('script attributes preserve literal whitespace instead of XML attribute normalization', () => {
  const source = '<root EXPR="return\r\n\t1;" PARAM="a\nb" PARAM="c\td"/>';
  const root = parseXml(source);
  assert.equal(root.attrs['EXPR'], 'return\r\n\t1;');
  assert.equal(root.attrs['PARAM'], 'a\nb,c\td');
});

void test('literal script operators and unknown entities match the original SPXML parser', () => {
  const root = parseXml('<root EXPR="a < b && c > d &custom; &constructor; &amp;custom;"/>');
  assert.equal(root.attrs['EXPR'], 'a < b && c > d &custom; &constructor; &custom;');
});

void test('named and numeric entities are decoded once without changing source spans', () => {
  const source = '<root value="&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#X43;&#x1F600;"/>';
  const root = parseXml(source);
  assert.equal(root.attrs['value'], '<>&"\'ABC\u{1f600}');
  const attribute = root.attributes[0];
  assert.ok(attribute);
  assert.equal(source.slice(attribute.valueSpan.start.offset, attribute.valueSpan.end.offset), '&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#X43;&#x1F600;');
});

void test('the first root and permissive attribute matching follow the original SPXML parser', () => {
  const root = parseXml('ignored<root bad a="1"a="2"/><other/>trailing text');
  assert.equal(root.name, 'root');
  assert.deepEqual(root.attributes.map(attribute => attribute.value), ['1', '2']);
  assert.equal(root.attrs['a'], '1,2');
  assert.equal(root.attrs['bad'], undefined);
});

void test('special attribute names remain safe when repeated', () => {
  const root = parseXml('<root __proto__="a" __proto__="b" constructor="c" toString="d"/>');
  assert.deepEqual(Object.entries(root.attrs), [['__proto__', 'a,b'], ['constructor', 'c'], ['toString', 'd']]);
  assert.equal(Object.getPrototypeOf(root.attrs), null);
});

void test('get_valid_filename preserves its complete script and repeated parameters', () => {
  const source = `<get_valid_filename PROPERTY="1" PARAM="_name" PARAM="bDoCutParam" EXPR="
		try
		{
			if ( bDoCutParam == true &amp;&amp; StrCharCount( _name ) &gt; 100 )
				_name = StrCharRangePos( _name, 0, 100 );
		}
		catch ( err )
		{
		}
		_name = StrReplace( _name, '&quot;', '\\'' );
		_name = StrReplace( _name, '&lt;', '{' );
		_name = StrReplace( _name, '&gt;', '}' );
		_name = StrReplace( _name, '#', '\u2116' );
		_name = StrReplace( _name, '?', '_' );
		_name = StrReplace( _name, '|', '_' );
		_name = StrReplace( _name, '*', '_' );
		_name = StrReplace( _name, '\\\\', '_' );
		_name = StrReplace( _name, '/', '_' );
		return StrReplace( _name, ':', '_' );
	"/>`;
  const expectedScript = `
		try
		{
			if ( bDoCutParam == true && StrCharCount( _name ) > 100 )
				_name = StrCharRangePos( _name, 0, 100 );
		}
		catch ( err )
		{
		}
		_name = StrReplace( _name, '"', '\\'' );
		_name = StrReplace( _name, '<', '{' );
		_name = StrReplace( _name, '>', '}' );
		_name = StrReplace( _name, '#', '\u2116' );
		_name = StrReplace( _name, '?', '_' );
		_name = StrReplace( _name, '|', '_' );
		_name = StrReplace( _name, '*', '_' );
		_name = StrReplace( _name, '\\\\', '_' );
		_name = StrReplace( _name, '/', '_' );
		return StrReplace( _name, ':', '_' );
	`;
  const root = parseXml(source, { sourceName: 'filename.xmd' });
  assert.equal(root.name, 'get_valid_filename');
  assert.equal(root.attrs['PROPERTY'], '1');
  assert.equal(root.attrs['PARAM'], '_name,bDoCutParam');
  assert.deepEqual(root.attributes.filter(attribute => attribute.name === 'PARAM').map(attribute => attribute.value), ['_name', 'bDoCutParam']);
  assert.equal(root.attrs['EXPR'], expectedScript);
  assert.deepEqual(root.children, []);
  const expression = root.attributes.find(attribute => attribute.name === 'EXPR');
  assert.ok(expression);
  assert.equal(expression.value, expectedScript);
  assert.equal(expression.valueSpan.sourceName, 'filename.xmd');
  assert.equal(expression.valueSpan.start.offset, source.indexOf('EXPR="') + 6);
  assert.equal(expression.valueSpan.end.offset, source.lastIndexOf('"'));
  assert.equal(source.slice(expression.valueSpan.start.offset, expression.valueSpan.end.offset), source.slice(source.indexOf('EXPR="') + 6, source.lastIndexOf('"')));
  assert.equal(root.span.end.offset, source.length);
});