import type { SourceSpan } from './diagnostics.ts';
import { normalizeFormUrl, type FormProvider } from './forms.ts';
import { childElements, type Field, type Form, type XmlElement } from './model.ts';

export const primitiveTypes: ReadonlySet<string> = new Set(['string', 'integer', 'bool', 'date', 'real', 'variant', 'attr', 'binary']);

export interface ResolveIssue {
  code: 'MISSING_FORM' | 'IMPORT_CYCLE' | 'UNKNOWN_TYPE' | 'UNKNOWN_INHERIT' | 'INHERITANCE_CYCLE' | 'REDEFINED_FIELD' | 'DEPTH_LIMIT';
  formUrl: string;
  path: string;
  detail: string;
  span?: SourceSpan;
}

export interface ResolveOptions {
  maxDepth?: number;
}

export interface ResolvedForm {
  form: Form;
  kind: 'object' | 'catalog' | 'library';
  root: Field | null;
  elements: Field[];
  issues: ResolveIssue[];
}

interface Template {
  form: Form;
  element: XmlElement;
}

interface Scope {
  own: Map<string, Template>;
  imported: Map<string, Template>;
}

const enabled = (value: string | undefined): boolean => value === '1' || value === 'true';

class Resolution {
  readonly issues: ResolveIssue[] = [];
  private readonly scopes = new Map<string, Scope>();
  private readonly importedScopes = new Map<string, Map<string, Template>>();
  private readonly provider: FormProvider;
  private readonly maxDepth: number;

  constructor(provider: FormProvider, maxDepth: number) {
    this.provider = provider;
    this.maxDepth = maxDepth;
  }

  private issue(code: ResolveIssue['code'], form: Form, path: string, detail: string, element?: XmlElement): void {
    this.issues.push({
      code,
      formUrl: form.url,
      path,
      detail,
      ...(element ? { span: element.span } : {})
    });
  }

  private scope(form: Form, depth = 0): Scope {
    const cached = this.scopes.get(form.url);

    if (cached) {
      return cached;
    }

    const scope: Scope = {
      own: new Map(),
      imported: this.importedScope(form, depth)
    };

    for (const element of form.elements) {
      if (element.attrs['PROPERTY'] !== '1') {
        scope.own.set(element.name, {
          form,
          element
        });
      }
    }

    this.scopes.set(form.url, scope);
    return scope;
  }

  private importedScope(form: Form, depth: number): Map<string, Template> {
    const cached = this.importedScopes.get(form.url);

    if (cached) {
      return cached;
    }

    const scope = new Map<string, Template>();
    this.importedScopes.set(form.url, scope);

    if (depth >= this.maxDepth) {
      this.issue('DEPTH_LIMIT', form, '', 'Import nesting limit exceeded', form.root);
      return scope;
    }

    for (const url of form.uses) {
      const used = this.provider.getForm(url);

      if (!used) {
        continue;
      }

      const imported = this.scope(used, depth + 1);

      for (const [name, template] of imported.imported) {
        scope.set(name, template);
      }

      for (const [name, template] of imported.own) {
        scope.set(name, template);
      }
    }

    return scope;
  }

  private template(form: Form, name: string, expanding: XmlElement[]): Template | undefined {
    const scope = this.scope(form);
    const selected = scope.own.get(name) ?? scope.imported.get(name);
    return selected && expanding.includes(selected.element) ? scope.imported.get(name) : selected;
  }

  private merge(form: Form, into: Field, field: Field, path: string): void {
    const existing = into.children.find(child => child.name === field.name);

    if (!existing) {
      into.children.push(field);
      return;
    }

    this.issue('REDEFINED_FIELD', form, `${path}/${field.name}`, '');
    existing.attrs = {
      ...existing.attrs,
      ...field.attrs
    };
    existing.attributeSpans = {
      ...existing.attributeSpans,
      ...field.attributeSpans
    };

    if (field.type !== undefined) {
      existing.type = field.type;
    }

    for (const child of field.children) {
      this.merge(form, existing, child, `${path}/${field.name}`);
    }
  }

  field(form: Form, element: XmlElement, path = element.name, expanding: XmlElement[] = []): Field {
    const { TYPE: type, ...attrs } = element.attrs;
    const attributeSpans = Object.fromEntries(element.attributes.filter(attribute => attribute.name !== 'TYPE').map(attribute => [attribute.name, attribute.valueSpan]));
    const field: Field = {
      name: element.name,
      attrs,
      attributeSpans,
      children: [],
      templates: [],
      span: element.span
    };

    if (expanding.length >= this.maxDepth) {
      this.issue('DEPTH_LIMIT', form, path, 'Field expansion limit exceeded', element);
      return field;
    }

    const stack = [...expanding, element];

    if (type && primitiveTypes.has(type)) {
      field.type = type;
    } else if (type) {
      const template = this.template(form, type, stack);

      if (!template) {
        field.type = type;
        this.issue('UNKNOWN_TYPE', form, path, type, element);
      } else if (stack.includes(template.element)) {
        this.issue('INHERITANCE_CYCLE', form, path, [...stack.map(item => item.name), type].join(' > '), element);
      } else {
        const base = this.field(template.form, template.element, path, stack);
        const baseAttrs = { ...base.attrs };
        const baseSpans = { ...base.attributeSpans };
        delete baseAttrs['SAMPLE'];
        delete baseSpans['SAMPLE'];
        field.attrs = {
          ...baseAttrs,
          ...attrs
        };
        field.attributeSpans = {
          ...baseSpans,
          ...attributeSpans
        };

        if (base.type !== undefined) {
          field.type = base.type;
        }

        field.children = base.children;
        field.templates = [type, ...base.templates];
      }
    }

    for (const child of childElements(element)) {
      if (child.name !== 'INHERIT') {
        this.merge(form, field, this.field(form, child, `${path}/${child.name}`, stack), path);
        continue;
      }

      const name = child.attrs['TYPE'] ?? '';
      const template = this.template(form, name, stack);

      if (!template) {
        this.issue('UNKNOWN_INHERIT', form, path, name, child);
      } else if (stack.includes(template.element)) {
        this.issue('INHERITANCE_CYCLE', form, path, [...stack.map(item => item.name), name].join(' > '), child);
      } else {
        const base = this.field(template.form, template.element, path, stack);

        for (const inherited of base.children) {
          this.merge(form, field, {
            ...inherited,
            templates: [name, ...inherited.templates]
          }, path);
        }
      }
    }

    return field;
  }

  resolve(form: Form): ResolvedForm {
    const top = form.elements.find(element => !enabled(element.attrs['SAMPLE']) && !enabled(element.attrs['PROPERTY']) && element.name !== 'SHARE');
    const root = top ? this.field(form, top) : null;
    const elements = form.elements.map(element => element === top && root ? root : new Resolution(this.provider, this.maxDepth).field(form, element));
    return {
      form,
      kind: root ? enabled(form.attrs['CATALOG']) ? 'catalog' : 'object' : 'library',
      root,
      elements,
      issues: this.issues
    };
  }
}

export function resolveForm(form: Form, provider: FormProvider, options: ResolveOptions = {}): ResolvedForm {
  const maxDepth = options.maxDepth ?? 256;

  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new RangeError('maxDepth must be a positive safe integer');
  }

  return new Resolution(provider, maxDepth).resolve(form);
}

export function findField(root: Field, path: string): Field | undefined {
  const [first, ...names] = path.split('.');

  if (first !== root.name) {
    return undefined;
  }

  let field: Field | undefined = root;

  for (const name of names) {
    field = field?.children.find(child => child.name === name);
  }

  return field;
}

export function resolveRegisteredForm(url: string, provider: FormProvider, options: ResolveOptions = {}): ResolvedForm {
  const normalized = normalizeFormUrl(url);
  const form = provider.getForm(normalized);

  if (!form) {
    throw new Error(`Form is not registered: ${normalized}`);
  }

  return resolveForm(form, provider, options);
}