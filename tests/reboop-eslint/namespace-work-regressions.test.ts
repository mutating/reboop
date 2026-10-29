import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

const declarations = Array.from(
  { length: 20 },
  (_, index) => `export interface Row${String(index)}{value:string}`,
).join('');
const properties = Array.from({ length: 20 }, (_, index) => `{value:${String(index)}}`).join(',');

describe('namespace erasure work', () => {
  /**
  Count declaration-list reads, not milliseconds. One framework traversal plus
  one analysis pass is sufficient per immutable namespace body; fewer reads
  also pass. The parser adapter returns unchanged AST data. The merged bodies
  and erased root alias check that true/false results stay isolated by body and
  retain native diagnostics. Recomputing a false cache entry becomes quadratic.
  */
  it.each([
    [
      'type-only alias and merged runtime',
      'const root=globalThis;namespace root {export interface Row{value:string}} namespace Shared {export interface Shape{value:string}} namespace Shared {export const rows=[{value:1},{value:2}];export const native=root.fetch;}',
      3,
    ],
    [
      'runtime',
      `namespace Generated {${declarations}export const data=[${properties}];export const native=globalThis.fetch;}`,
      1,
    ],
  ] as const)('bounds %s declaration-list work', async (_name, code, bodyCount) => {
    const scans: { count: number }[] = [];
    const measuredParser = {
      ...parser,
      parseForESLint(
        ...parserArguments: Parameters<typeof parser.parseForESLint>
      ): ReturnType<typeof parser.parseForESLint> {
        interface Statement {
          type: string;
          declaration?: Statement | null;
          body?: { type: string; body: unknown[] };
        }
        const parsed = parser.parseForESLint(...parserArguments);
        const ast = parsed.ast as { body: Statement[] };
        for (const statement of ast.body) {
          const declaration =
            statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
          if (
            declaration?.type !== 'TSModuleDeclaration' ||
            declaration.body?.type !== 'TSModuleBlock'
          ) {
            continue;
          }
          const block = declaration.body;
          const body = block.body;
          const counter = { count: 0 };
          scans.push(counter);
          Object.defineProperty(block, 'body', {
            get(): unknown[] {
              counter.count += 1;
              return body;
            },
          });
        }
        return parsed;
      },
    };
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser: measuredParser } },
    ]);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
    expect(scans).toHaveLength(bodyCount);
    expect(scans.every((value) => value.count <= 2)).toBe(true);
  });
});
