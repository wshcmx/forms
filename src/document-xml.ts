import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseForm, type FormRegistry } from './forms.ts';
import type { DocumentNode, Form } from './model.ts';

export type { DocumentNode } from './model.ts';

export interface DocumentParseOptions {
  maxDepth?: number;
}

export interface DocumentSerializeOptions {
  header?: boolean;
  formUrl?: string;
}

export class DocumentXmlError extends Error {
  readonly code: 'INVALID_XML' | 'DEPTH_LIMIT';

  constructor(message: string, code: 'INVALID_XML' | 'DEPTH_LIMIT' = 'INVALID_XML') {
    super(message);
    this.name = 'DocumentXmlError';
    this.code = code;
  }
}

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  cdataPropName: '#cdata'
});

const xmlBuilder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  suppressEmptyNode: true
});

const ignoredMarkup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;
const predefinedEntities = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function elementName(record: Record<string, unknown>): string | undefined {
  return Object.keys(record).find(key => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'));
}

function isValidXmlCodePoint(value: number): boolean {
  return value === 0x9 || value === 0xa || value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff);
}

function validateXmlSyntax(source: string): void {
  const validation = XMLValidator.validate(source);

  if (validation !== true) {
    throw new DocumentXmlError(`Invalid XML: ${validation.err.msg}`);
  }
}

function validateXmlContent(source: string): void {
  const markup = source.replace(ignoredMarkup, '');

  if (/<!DOCTYPE\b/.test(markup)) {
    throw new DocumentXmlError('DOCTYPE is not supported in document XML');
  }

  for (const match of markup.matchAll(/&([^;]*);/g)) {
    const entity = match[1] ?? '';

    if (predefinedEntities.has(entity)) {
      continue;
    }

    if (entity.startsWith('#')) {
      const hexadecimal = entity.startsWith('#x');
      const digits = entity.slice(hexadecimal ? 2 : 1);
      const validDigits = hexadecimal ? /^[0-9a-f]+$/i.test(digits) : /^\d+$/.test(digits);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);

      if (validDigits && Number.isSafeInteger(codePoint) && isValidXmlCodePoint(codePoint)) {
        continue;
      }
    }

    throw new DocumentXmlError(`Invalid XML: Unknown or invalid entity &${entity};`);
  }
}

function toDocumentNode(record: Record<string, unknown>, depth: number, maxDepth: number): DocumentNode {
  if (depth >= maxDepth) {
    throw new DocumentXmlError('Document nesting limit exceeded', 'DEPTH_LIMIT');
  }

  const name = elementName(record);
  const content = name ? record[name] : undefined;

  if (!name || !Array.isArray(content)) {
    throw new DocumentXmlError('Invalid XML: Expected an element');
  }

  const rawAttributes = record[':@'];
  const attributes: [string, string][] = [];

  if (rawAttributes !== undefined) {
    if (!isRecord(rawAttributes)) {
      throw new DocumentXmlError('Invalid XML: Invalid attributes');
    }

    for (const [attributeName, value] of Object.entries(rawAttributes)) {
      if (typeof value !== 'string') {
        throw new DocumentXmlError('Invalid XML: Invalid attribute value');
      }

      attributes.push([attributeName, value]);
    }
  }

  const children: DocumentNode[] = [];
  let text = '';

  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    if (typeof item['#text'] === 'string') {
      text += item['#text'];
      continue;
    }

    if (Array.isArray(item['#cdata'])) {
      for (const part of item['#cdata']) {
        if (isRecord(part) && typeof part['#text'] === 'string') {
          text += part['#text'];
        }
      }

      continue;
    }

    if (elementName(item)) {
      children.push(toDocumentNode(item, depth + 1, maxDepth));
    }
  }

  return { name, text, attributes, children };
}

function orderedElement(node: DocumentNode): Record<string, unknown> {
  const children: Record<string, unknown>[] = [];

  if (node.text !== '') {
    children.push({ '#text': node.text });
  }

  children.push(...node.children.map(orderedElement));
  const element: Record<string, unknown> = { [node.name]: children };

  if (node.attributes.length > 0) {
    element[':@'] = Object.fromEntries(node.attributes);
  }

  return element;
}

export function parseDocumentXml(source: string, options: DocumentParseOptions = {}): DocumentNode {
  const maxDepth = options.maxDepth ?? 256;

  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new TypeError('maxDepth must be a positive safe integer');
  }

  try {
    validateXmlContent(source);

    if (/^\uFEFF?<\?xml\b/.test(source)) {
      validateXmlSyntax(source);
    }

    const withoutDeclaration = source.replace(/^\uFEFF?<\?xml\s+[^?]*\?>/, '');
    const wrapped = `<__document_wrapper__>${withoutDeclaration}</__document_wrapper__>`;
    validateXmlSyntax(wrapped);

    const parsed: unknown = xmlParser.parse(wrapped);

    if (!Array.isArray(parsed) || !isRecord(parsed[0])) {
      throw new DocumentXmlError('XML has no root element');
    }

    const wrapperContents = parsed[0]['__document_wrapper__'];

    if (!Array.isArray(wrapperContents)) {
      throw new DocumentXmlError('XML has no root element');
    }

    const roots: Record<string, unknown>[] = [];

    for (const item of wrapperContents) {
      if (!isRecord(item)) {
        continue;
      }

      if (typeof item['#text'] === 'string') {
        if (item['#text'].trim() !== '') {
          throw new DocumentXmlError('Invalid XML: Text outside the root element');
        }

        continue;
      }

      if (elementName(item)) {
        roots.push(item);
      }
    }

    if (roots.length !== 1) {
      throw new DocumentXmlError(roots.length === 0 ? 'XML has no root element' : 'Invalid XML: Multiple root elements');
    }

    const root = roots[0];

    if (!root) {
      throw new DocumentXmlError('XML has no root element');
    }

    return toDocumentNode(root, 0, maxDepth);
  } catch (error) {
    if (error instanceof DocumentXmlError) {
      throw error;
    }

    throw new DocumentXmlError(`Invalid XML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function serializeDocumentXml(node: DocumentNode, options: DocumentSerializeOptions = {}): string {
  if (options.formUrl !== undefined) {
    node = {
      ...node,
      attributes: [...node.attributes.filter(([name]) => name !== 'SPXML-FORM'), ['SPXML-FORM', options.formUrl]]
    };
  }

  const header = options.header ? '<?xml version="1.0" encoding="utf-8"?>\r\n' : '';
  return header + xmlBuilder.build([orderedElement(node)]);
}

export function inferDocumentForm(root: DocumentNode, url: string, registry?: FormRegistry): Form {
  const field = (nodes: DocumentNode[]): DocumentNode => {
    const first = nodes[0];

    if (!first) {
      throw new TypeError('Cannot infer a field without data');
    }

    const attributes: [string, string][] = [['DYNAMIC', '1']];
    const grouped = new Map<string, DocumentNode[]>();

    for (const node of nodes) {
      for (const child of node.children) {
        const group = grouped.get(child.name) ?? [];
        group.push(child);
        grouped.set(child.name, group);
      }
    }

    if (!grouped.size || nodes.some(node => node.text.trim() !== '')) {
      attributes.push(['TYPE', 'string']);
    }

    const children: DocumentNode[] = [];

    for (const [name, group] of grouped) {
      const child = field(group);

      if (nodes.some(node => node.children.filter(item => item.name === name).length > 1)) {
        child.attributes.push(['MULTIPLE', '1']);
      }

      children.push(child);
    }

    return { name: first.name, text: '', attributes, children };
  };
  const inferred: DocumentNode = {
    name: 'SPXML-FORM',
    text: '',
    attributes: [],
    children: [field([root])]
  };
  const source = xmlBuilder.build([orderedElement(inferred)]);
  return registry ? registry.register(source, url) : parseForm(source, url);
}