export interface Position {
  offset: number;
  line: number;
  column: number;
}

export interface SourceSpan {
  sourceName: string;
  start: Position;
  end: Position;
}

export interface ParseOptions {
  sourceName?: string;
  firstLine?: number;
  maxDepth?: number;
}

export type DiagnosticCode = 'INVALID_XML' | 'INVALID_FORM' | 'UNSUPPORTED_DOCTYPE' | 'DEPTH_LIMIT';

export class FormSyntaxError extends SyntaxError {
  readonly code: DiagnosticCode;
  readonly span: SourceSpan;

  constructor(code: DiagnosticCode, message: string, span: SourceSpan) {
    super(`${message} (${span.sourceName}:${String(span.start.line)}:${String(span.start.column)})`);
    this.name = 'FormSyntaxError';
    this.code = code;
    this.span = span;
  }
}

export function sourceLocator(source: string, options: ParseOptions): (start: number, end: number) => SourceSpan {
  const firstLine = options.firstLine ?? 1;

  if (!Number.isSafeInteger(firstLine) || firstLine < 1) {
    throw new RangeError('firstLine must be a positive safe integer');
  }

  const starts = [0];

  for (let offset = 0; offset < source.length; offset++) {
    if (source[offset] === '\r') {
      if (source[offset + 1] === '\n') {
        offset++;
      }

      starts.push(offset + 1);
    } else if (source[offset] === '\n') {
      starts.push(offset + 1);
    }
  }

  const position = (offset: number): Position => {
    let lower = 0;
    let upper = starts.length;

    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);

      if ((starts[middle] ?? 0) <= offset) {
        lower = middle;
      } else {
        upper = middle;
      }
    }

    return {
      offset,
      line: firstLine + lower,
      column: offset - (starts[lower] ?? 0) + 1
    };
  };
  return (start, end) => ({
    sourceName: options.sourceName ?? '<anonymous>',
    start: position(start),
    end: position(end)
  });
}