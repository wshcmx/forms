import { FormSyntaxError, sourceLocator, type ParseOptions } from './diagnostics.ts';
import type { XmlAttribute, XmlElement } from './model.ts';

const entities = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"]
]);

export function parseXml(source: string, options: ParseOptions = {}): XmlElement {
  const locate = sourceLocator(source, options);
  const maxDepth = options.maxDepth ?? 256;

  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new RangeError('maxDepth must be a positive safe integer');
  }

  const decodeEntities = (value: string, start: number, end: number): string => {
    return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match: string, entity: string): string => {
      if (!entity.startsWith('#')) {
        return entities.get(entity) ?? match;
      }

      const hexadecimal = entity.charAt(1).toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);

      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new FormSyntaxError('INVALID_XML', 'Invalid numeric character reference', locate(start, end));
      }

      return String.fromCodePoint(codePoint);
    });
  };

  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let offset = 0;

  while (offset < source.length) {
    const start = source.indexOf('<', offset);

    if (start < 0) {
      break;
    }

    if (source.startsWith('<!--', start) || source.startsWith('<![CDATA[', start) || source.startsWith('<?', start)) {
      const terminator = source.startsWith('<!--', start) ? '-->' : source.startsWith('<?', start) ? '?>' : ']]>';
      const end = source.indexOf(terminator, start + 2);

      if (end < 0) {
        throw new FormSyntaxError('INVALID_XML', 'Unterminated XML section', locate(start, source.length));
      }

      offset = end + terminator.length;
      continue;
    }

    if (source.startsWith('<!', start)) {
      const end = source.indexOf('>', start + 2);

      if (end < 0) {
        throw new FormSyntaxError('INVALID_XML', 'Unterminated XML declaration', locate(start, source.length));
      }

      offset = end + 1;
      continue;
    }

    let end = start + 1;
    let quote = '';

    for (; end < source.length; end++) {
      const character = source.charAt(end);

      if (quote) {
        if (character === quote) {
          quote = '';
        }
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }

    if (end === source.length) {
      throw new FormSyntaxError('INVALID_XML', 'Unterminated XML tag', locate(start, end));
    }

    const tag = source.slice(start + 1, end);
    offset = end + 1;

    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const element = stack.pop();

      if (element?.name !== name) {
        throw new FormSyntaxError('INVALID_XML', 'Unexpected closing tag', locate(start, offset));
      }

      element.span = locate(element.span.start.offset, offset);
      continue;
    }

    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const name = /^[^\s/>]+/.exec(body)?.[0];

    if (!name) {
      throw new FormSyntaxError('INVALID_XML', 'Expected an element name', locate(start, offset));
    }

    if (stack.length >= maxDepth) {
      throw new FormSyntaxError('DEPTH_LIMIT', 'XML nesting limit exceeded', locate(start, offset));
    }

    const attrs: Record<string, string> = {};
    Object.setPrototypeOf(attrs, null);
    const attributes: XmlAttribute[] = [];
    const attributePattern = /([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;

    for (const match of body.slice(name.length).matchAll(attributePattern)) {
      const attributeName = match[1] ?? '';
      const quoted = match[2] ?? '';
      const attributeStart = start + 1 + name.length + match.index;
      const valueStart = attributeStart + match[0].length - quoted.length + 1;
      const valueEnd = valueStart + quoted.length - 2;
      const value = decodeEntities(source.slice(valueStart, valueEnd), valueStart, valueEnd);
      attributes.push({
        name: attributeName,
        value,
        span: locate(attributeStart, attributeStart + match[0].length),
        valueSpan: locate(valueStart, valueEnd)
      });
      const previous = attrs[attributeName];
      attrs[attributeName] = previous !== undefined ? `${previous},${value}` : value;
    }

    const element: XmlElement = {
      kind: 'element',
      name,
      attrs,
      attributes,
      children: [],
      span: locate(start, offset)
    };
    const parent = stack.at(-1);

    if (parent) {
      parent.children.push(element);
    } else {
      root ??= element;
    }

    if (!selfClosing) {
      stack.push(element);
    }
  }

  const unclosed = stack.at(-1);

  if (unclosed) {
    throw new FormSyntaxError('INVALID_XML', 'Unclosed XML tag', locate(unclosed.span.start.offset, source.length));
  }

  if (!root) {
    throw new FormSyntaxError('INVALID_XML', 'Expected a root element', locate(0, source.length));
  }

  return root;
}