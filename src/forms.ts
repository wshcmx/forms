import { FormSyntaxError, type ParseOptions } from './diagnostics.ts';
import { childElements, type Form } from './model.ts';
import { parseXml } from './xml.ts';

export function normalizeFormUrl(url: string, base?: string): string {
  if (url.startsWith('//')) {
    return `x-local:${url}`;
  }

  if (/^[A-Za-z][\w+.-]*:/.test(url)) {
    return url;
  }

  if (base) {
    return base.slice(0, base.lastIndexOf('/') + 1) + url;
  }

  throw new TypeError('A relative form URL requires a base URL');
}

export function parseForm(source: string, url: string, options: ParseOptions = {}): Form {
  const normalized = normalizeFormUrl(url);
  const root = parseXml(source, {
    ...options,
    sourceName: options.sourceName ?? normalized
  });

  const elements = childElements(root);
  const uses: string[] = [];

  for (const element of elements) {
    if (element.name !== 'USE') {
      continue;
    }

    const reference = element.attrs['FORM'];

    if (reference === undefined) {
      throw new FormSyntaxError('INVALID_FORM', 'USE requires a FORM attribute', element.span);
    }

    uses.push(normalizeFormUrl(reference, normalized));
  }

  return {
    url: normalized,
    inline: root.name === 'SPXML-INLINE-FORM',
    attrs: root.attrs,
    uses,
    elements: elements.filter(element => element.name !== 'USE'),
    root
  };
}

export interface FormProvider {
  getForm(url: string): Form | undefined;
}

export class FormRegistry implements FormProvider {
  private readonly forms = new Map<string, Form>();

  register(source: string, url: string, options: ParseOptions = {}): Form {
    const form = parseForm(source, url, options);
    this.forms.set(form.url, form);
    return form;
  }

  getForm(url: string): Form | undefined {
    return this.forms.get(normalizeFormUrl(url));
  }

  remove(url: string): boolean {
    return this.forms.delete(normalizeFormUrl(url));
  }
}