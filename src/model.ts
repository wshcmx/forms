import type { SourceSpan } from './diagnostics.ts';

export interface XmlAttribute {
  name: string;
  value: string;
  span: SourceSpan;
  valueSpan: SourceSpan;
}

export interface XmlText {
  kind: 'text' | 'cdata';
  value: string;
}

export interface XmlElement {
  kind: 'element';
  name: string;
  attrs: Record<string, string>;
  attributes: XmlAttribute[];
  children: (XmlElement | XmlText)[];
  span: SourceSpan;
}

export interface Form {
  url: string;
  inline: boolean;
  attrs: Record<string, string>;
  uses: string[];
  elements: XmlElement[];
  root: XmlElement;
}

export interface DocumentNode {
  name: string;
  text: string;
  attributes: [string, string][];
  children: DocumentNode[];
}

export interface Field {
  name: string;
  type?: string;
  attrs: Record<string, string>;
  attributeSpans: Record<string, SourceSpan>;
  children: Field[];
  templates: string[];
  span: SourceSpan;
}

export function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.kind === 'element');
}