import { ESLint } from 'eslint';
import type { Linter, Rule, Scope } from 'eslint';
import { parser } from 'typescript-eslint';
import { describe, expect, it, vi } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

const captured = vi.hoisted(() => {
  const value = {
    scope: undefined as Scope.Scope | undefined,
    find: undefined as typeof import('@eslint-community/eslint-utils').findVariable | undefined,
    reset(): void {
      value.scope = undefined;
    },
  };
  return value;
});
vi.mock('@eslint-community/eslint-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eslint-community/eslint-utils')>();
  captured.find = actual.findVariable;
  return {
    ...actual,
    getPropertyName(
      ...arguments_: Parameters<typeof actual.getPropertyName>
    ): ReturnType<typeof actual.getPropertyName> {
      captured.scope = arguments_[1];
      return actual.getPropertyName(...arguments_);
    },
  };
});

/**
Measure parser-owned identifier reads without changing their values.
*/
async function measuredLint(
  code: string,
  filePath = 'src/client.js',
  config: Linter.Config[] = [],
): Promise<{
  result: ESLint.LintResult;
  identifiers: Scope.Reference['identifier'][];
  rangeReads: number;
  scope: Scope.Scope;
}> {
  let rangeReads = 0;
  let identifiers: Scope.Reference['identifier'][] = [];
  captured.reset();
  const probe: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      identifiers = [
        ...new Set(
          context.sourceCode.scopeManager.scopes.flatMap((scope) =>
            scope.references.map((reference) => reference.identifier),
          ),
        ),
      ];
      for (const identifier of identifiers) {
        const range = identifier.range;
        if (range === undefined) {
          throw new Error('Expected an identifier range');
        }
        Object.defineProperty(identifier, 'range', {
          get(): [number, number] {
            rangeReads += 1;
            return range;
          },
        });
      }
      return {};
    },
  };
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        plugins: { probe: { rules: { ranges: probe } } },
        rules: { 'probe/ranges': 'error' },
      },
      plugin.configs.recommended,
      ...config,
    ],
  });
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined || captured.scope === undefined) {
    throw new Error('Expected a lint result and constant-evaluator scope');
  }
  expect(result.fatalErrorCount).toBe(0);
  expect(result.warningCount).toBe(0);
  return { result, identifiers, rangeReads, scope: captured.scope };
}

const padding = Array.from({ length: 32 }, (_, index) => `const padding${String(index)}=0;`).join(
  '',
);

describe('constant-evaluator reference frame index', () => {
  /**
  Constant computed keys need a scope lookup at each access. Count identifier
  range reads rather than time: building and searching the index stays far
  below the repeated full-frame scan. Exact native diagnostics prevent skipping
  analysis from satisfying the work budget. Removing the index exceeds it.
  Nested function scopes put references after the final top-level access in
  parser order, so a missing or broken source-order comparator also fails.
  */
  it.each(['top-level', 'nested scopes'])('bounds scope lookup work for %s', async (location) => {
    const count = 256;
    const accesses = Array.from({ length: count }, (_, index) =>
      location === 'nested scopes'
        ? `function read${String(index)}(){return globalThis[key];}`
        : `const result${String(index)}=globalThis[key];`,
    ).join('');
    const tail = location === 'nested scopes' ? 'globalThis[key];' : '';
    const { result, identifiers, rangeReads } = await measuredLint(
      `const key='fetch';${accesses}${tail}`,
    );
    expect(result.messages).toHaveLength(count + Number(tail.length > 0));
    expect(result.messages.every((message) => message.ruleId === 'reboop/require-client')).toBe(
      true,
    );
    expect(rangeReads).toBeLessThanOrEqual(identifiers.length * 32);
  });

  /**
  One computed key triggers reference indexing for the whole file. Ordinary
  member reads elsewhere need no evaluator lookup. Counting real identifier
  range reads bounds construction work without prescribing a tree layout:
  sorting or checking already ordered partitions again exceeds this budget.
  Maps keyed by the actual virtual frames reveal unnecessary ordering state
  for overlap groups; disjoint references must not allocate that extra state.
  The required native diagnostic also catches bypassing the analysis entirely.
  */
  it('does not recheck ordered partitions while building the reference index', async () => {
    const maps = vi.spyOn(globalThis, 'Map');
    try {
      const padding = Array.from(
        { length: 512 },
        (_, index) => `function reader${String(index)}(){return source.value;}`,
      ).join('');
      const { result, identifiers, rangeReads, scope } = await measuredLint(
        `const source={value:1};${padding}const key='fetch';globalThis[key];`,
      );
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
      expect(rangeReads).toBeLessThanOrEqual(identifiers.length * 12);
      const root = Object.getPrototypeOf(scope) as Scope.Scope;
      const isFrame = (value: unknown): boolean =>
        typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === root;
      const orderingMaps = maps.mock.calls.filter(
        ([entries]) =>
          Array.isArray(entries) &&
          entries.some((entry: unknown) => Array.isArray(entry) && isFrame(entry[0])),
      ).length;
      expect(orderingMaps).toBe(0);
    } finally {
      maps.mockRestore();
    }
  });

  /**
  Small modules need a constant-key lookup but gain no useful search depth from
  grouping a handful of references. Bound allocations by real references plus
  the evaluator root, so adding redundant grouping work on small inputs fails.
  Native diagnostics must still be present. Include several sizes to cover
  ordinary tiny modules as well as the small-input boundary.
  */
  it.each([0, 4, 5])('avoids grouping overhead for a module with %i helpers', async (helpers) => {
    const create = vi.spyOn(Object, 'create');
    try {
      const declarations = Array.from(
        { length: helpers },
        (_, index) => `const local${String(index)}=0;`,
      ).join('');
      const { result, identifiers, scope } = await measuredLint(
        `const key='fetch';${declarations}globalThis[key];`,
      );
      expect(result.messages).toHaveLength(1);
      const root = Object.getPrototypeOf(scope) as Scope.Scope;
      expect(
        create.mock.calls.filter(([prototype]) => (prototype as unknown) === root).length,
      ).toBeLessThanOrEqual(identifiers.length + 1);
    } finally {
      create.mockRestore();
    }
  });

  /**
  A mutable binding is deliberately unavailable to constant evaluation, while
  an independent immutable key still resolves to Fetch. Unsupported entries
  must not throw during construction and poison every other reference frame.
  Corrupting the empty binding map loses the required native diagnostic.
  */
  it('keeps independent constants available alongside a reassigned binding', async () => {
    const { result } = await measuredLint(
      "let changed='fetch';changed='local';const key='fetch';globalThis[changed];globalThis[key];",
    );
    expect(result.messages).toEqual([
      expect.objectContaining({ ruleId: 'reboop/require-client', column: 75 }),
    ]);
  });

  /**
  Virtual grouping scopes must inherit the old root's set and upper lookup
  behavior for untracked positions. The first identifier's end is excluded
  from its frame and lies in a genuine gap. Querying the evaluator interface
  there must find the same builtin as the old root, and unknown names stay null.
  Giving groups a leaf frame's prototype or an empty set breaks this contract.
  */
  it('preserves root fallback at an identifier end and in a gap', async () => {
    const { identifiers, scope } = await measuredLint(
      `const key='fetch';${padding}globalThis[key];`,
    );
    const first = identifiers[0];
    if (first?.range === undefined) {
      throw new Error('Expected the first reference range');
    }
    const root = Object.getPrototypeOf(scope) as Scope.Scope;
    const findVariable = captured.find;
    if (findVariable === undefined) {
      throw new Error('Expected the evaluator variable lookup');
    }
    const [start, end] = first.range;
    const query = {
      type: 'Identifier' as const,
      name: 'Math',
      range: [end, end + 1] as [number, number],
    };
    expect(findVariable(scope, query)).toBe(findVariable(root, 'Math'));
    query.range = [end + 1, end + 2];
    expect(findVariable(scope, query)).toBe(findVariable(root, 'Math'));
    query.name = 'missingBinding';
    expect(findVariable(scope, query)).toBeNull();
    query.name = first.name;
    query.range = [start, start + 1];
    expect(findVariable(scope, query)?.name).toBe(first.name);
  });

  /**
  A TypeScript binding range can contain its annotation's reference range.
  Reference arrays need not be in source order: this parser adapter reverses
  them without changing AST nodes or binding identities. At overlapping ranges,
  findVariable must preserve the original first-match binding pointer. Compare
  actual lookups with the old flat view, allowing any equivalent index layout.
  */
  it('keeps overlapping TypeScript lookup priority from the parser', async () => {
    const annotationFirstParser = {
      ...parser,
      parseForESLint(
        ...arguments_: Parameters<typeof parser.parseForESLint>
      ): ReturnType<typeof parser.parseForESLint> {
        const parsed = parser.parseForESLint(...arguments_);
        const manager = parsed.scopeManager as Scope.ScopeManager;
        for (const scope of manager.scopes) {
          scope.references = scope.references.toReversed();
        }
        return parsed;
      },
    };
    const { result, identifiers, scope } = await measuredLint(
      `type Name='fetch';const key:Name='fetch';${padding}globalThis[key];`,
      'src/client.ts',
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: annotationFirstParser },
        },
      ],
    );
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
    const findVariable = captured.find;
    if (findVariable === undefined) {
      throw new Error('Expected the evaluator variable lookup');
    }
    const leaves = new Map<unknown, Scope.Scope>();
    function collect(frame: Scope.Scope): void {
      if (frame.childScopes.length === 0) {
        leaves.set(frame.block, frame);
      } else {
        for (const child of frame.childScopes) {
          collect(child);
        }
      }
    }
    for (const child of scope.childScopes) {
      collect(child);
    }
    const flat = Object.create(Object.getPrototypeOf(scope) as Scope.Scope, {
      childScopes: {
        value: identifiers.map((identifier) => leaves.get(identifier)),
      },
    }) as Scope.Scope;
    for (const identifier of identifiers) {
      if (identifier.type === 'Identifier') {
        expect(findVariable(scope, identifier)).toBe(findVariable(flat, identifier));
      }
    }
  });

  /**
  Two files can have identical identifier ranges but opposite key values.
  Scope indexes are tied to their lint operation; reusing frames by source
  offsets would retain the previous file's fetch constant and misdiagnose the
  local property name in the next file.
  */
  it('keeps same-position indexes separate between lint operations', async () => {
    const first = await measuredLint(`const key='fetch';${padding}globalThis[key];`);
    const second = await measuredLint(`const key='local';${padding}globalThis[key];`);
    expect(first.result.messages).toHaveLength(1);
    expect(second.result.messages).toEqual([]);
  });

  /**
  A TypeScript annotation overlaps its binding reference, but that local overlap
  must not force full-file linear searches for every later constant key. Count
  real range reads for one annotated binding and many independent annotations;
  every native access must still report, preserving both lookup paths.
  */
  it.each(['one annotation', 'many annotations'])('bounds lookup work with %s', async (layout) => {
    const count = 256;
    const accesses = Array.from({ length: count }, (_, index) =>
      layout === 'many annotations'
        ? `const key${String(index)}:Name='fetch';globalThis[key${String(index)}];`
        : `const result${String(index)}=globalThis[key];`,
    ).join('');
    const declaration = layout === 'one annotation' ? "const key:Name='fetch';" : '';
    const { result, identifiers, rangeReads } = await measuredLint(
      `type Name='fetch';${declaration}${accesses}`,
      'src/client.ts',
      [{ files: ['**/*.ts'], languageOptions: { parser } }],
    );
    expect(result.messages).toHaveLength(count);
    expect(result.messages.every((message) => message.ruleId === 'reboop/require-client')).toBe(
      true,
    );
    expect(rangeReads).toBeLessThanOrEqual(identifiers.length * 32);
  });

  /**
  After a small overlapping pair is grouped, only a handful of lookup entries
  remain. Count root-derived allocations to avoid building redundant search
  levels for this tiny module: each reference, the evaluator root, and one
  overlap group suffice. Required diagnostics protect the semantic result.
  */
  it('avoids redundant search levels after grouping a small annotation overlap', async () => {
    const create = vi.spyOn(Object, 'create');
    try {
      const { result, identifiers, scope } = await measuredLint(
        "type Name='fetch';const key:Name='fetch';globalThis[key];globalThis[key];globalThis[key];key;",
        'src/client.ts',
        [{ files: ['**/*.ts'], languageOptions: { parser } }],
      );
      expect(result.messages).toHaveLength(3);
      const root = Object.getPrototypeOf(scope) as Scope.Scope;
      expect(
        create.mock.calls.filter(([prototype]) => (prototype as unknown) === root).length,
      ).toBeLessThanOrEqual(identifiers.length + 2);
    } finally {
      create.mockRestore();
    }
  });

  /**
  The outer binding range includes the closing > of a nested type annotation,
  beyond every inner type identifier. Group bounds must preserve that final
  character even when the final inserted inner reference ends earlier. Query
  the real parser range at end-1 and end to distinguish the original binding
  view from root fallback, preserving half-open lookup semantics.
  */
  it('preserves outer annotation bounds and exclusive-end fallback', async () => {
    const code = `type Name='fetch';const key:Readonly<Name>='fetch';${padding}globalThis[key];`;
    const { result, identifiers, scope } = await measuredLint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toHaveLength(1);
    const binding = identifiers.find(
      (identifier) =>
        identifier.range !== undefined &&
        identifier.name === 'key' &&
        identifier.range[1] - identifier.range[0] > 3,
    );
    const findVariable = captured.find;
    if (
      findVariable === undefined ||
      binding?.type !== 'Identifier' ||
      binding.range === undefined
    ) {
      throw new Error('Expected an annotated reference and evaluator lookup');
    }
    const [, end] = binding.range;
    expect(code[end - 1]).toBe('>');
    const query = {
      type: 'Identifier' as const,
      name: 'key',
      range: [end - 1, end] as [number, number],
    };
    const expected = findVariable(scope, binding);
    expect(expected).not.toBeNull();
    expect(findVariable(scope, query)).toBe(expected);
    query.range = [end, end + 1];
    const root = Object.getPrototypeOf(scope) as Scope.Scope;
    expect(findVariable(scope, query)).toBe(findVariable(root, 'key'));
  });
});
