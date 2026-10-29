import { AST_NODE_TYPES as types } from '@typescript-eslint/types';
import { findVariable, getPropertyName, getStringIfConstant } from '@eslint-community/eslint-utils';
import type { TSESTree as AST } from '@typescript-eslint/types';
import type { Rule, Scope, SourceCode } from 'eslint';
import {
  absent,
  builtinLoader,
  common,
  globals,
  instances,
  loader,
  loaderFactory,
  member,
  moduleOrigin,
  namespace,
  namespaceMember,
  opaque,
  promise,
  promiseValue,
} from './transports.js';
import type { Origin } from './transports.js';

type Identifier = AST.Identifier | AST.JSXIdentifier;

// TypeScript namespaces and enums emit ordinary IIFEs with their own arguments.
const argumentScopes = new Set<string>(['function', 'tsModule', 'tsEnum']);

// Import/export members permit identifier or string-literal names.
export function symbolName(node: AST.Identifier | AST.StringLiteral): string {
  return node.type === types.Identifier ? node.name : node.value;
}

export function isValueAssignment(operator: AST.AssignmentExpression['operator']): boolean {
  return ['=', '&&=', '||=', '??='].includes(operator);
}

function wrappedExpression(node: AST.Node): AST.Expression | undefined {
  return node.type === types.ChainExpression ||
    node.type === types.TSAsExpression ||
    node.type === types.TSSatisfiesExpression ||
    node.type === types.TSTypeAssertion ||
    node.type === types.TSNonNullExpression ||
    node.type === types.TSInstantiationExpression
    ? node.expression
    : undefined;
}

function unwrap<T extends AST.Node>(input: T): T | AST.Expression {
  let node: T | AST.Expression = input;
  let wrapped = wrappedExpression(node);
  while (wrapped !== undefined) {
    node = wrapped;
    wrapped = wrappedExpression(node);
  }
  return node;
}

function callbackValue(input: AST.Expression): AST.Expression {
  let node = input;
  while (true) {
    const parent = node.parent;
    // A function value, including these carriers, cannot be an assignment target.
    const isCarrier =
      parent.type === types.AssignmentExpression
        ? isValueAssignment(parent.operator)
        : wrappedExpression(parent) === node ||
          (parent.type === types.SequenceExpression && parent.expressions.at(-1) === node) ||
          parent.type === types.AwaitExpression ||
          (parent.type === types.ConditionalExpression && parent.test !== node) ||
          (parent.type === types.LogicalExpression &&
            (parent.right === node || parent.operator !== '&&'));
    if (!isCarrier) {
      return node;
    }
    // Every admitted parent above is an expression carrying this value.
    node = parent as AST.Expression;
  }
}

// ESLint completes parent links before rule creation; weak keys do not retain ASTs.
const typeOnly = new WeakMap<AST.Node, boolean>();

export function isTypeOnly(node: AST.Node | null): boolean {
  const pending: AST.Node[] = [];
  let isErased = false;
  for (let current: AST.Node | null | undefined = node; current; current = current.parent) {
    const cached = typeOnly.get(current);
    if (cached !== undefined) {
      isErased = cached;
      break;
    }
    pending.push(current);
    if (
      current.type === types.TSTypeLiteral ||
      current.type === types.TSTypeQuery ||
      current.type === types.TSDeclareFunction ||
      current.type === types.TSClassImplements ||
      isErasedNamespace(current) ||
      ((current.type === types.TSAbstractPropertyDefinition ||
        current.type === types.TSAbstractAccessorProperty ||
        current.type === types.TSAbstractMethodDefinition ||
        (current.type === types.MethodDefinition &&
          current.value.type === types.TSEmptyBodyFunctionExpression)) &&
        // Legacy decorators emit member keys even for abstract declarations.
        current.decorators.length === 0) ||
      ('importKind' in current && current.importKind === 'type') ||
      ('exportKind' in current && current.exportKind === 'type') ||
      ('declare' in current &&
        current.declare &&
        // Legacy decorators still execute on declare fields of a runtime class.
        !(current.type === types.PropertyDefinition && current.decorators.length > 0))
    ) {
      isErased = true;
      break;
    }
  }
  for (const item of pending) {
    typeOnly.set(item, isErased);
  }
  return isErased;
}

// Parsed namespace bodies are immutable; weak keys do not retain linted files.
const erasedNamespaces = new WeakMap<AST.TSModuleBlock, boolean>();

function isErasedNamespace(input: AST.Node): boolean {
  let node = input;
  while (node.type === types.TSModuleDeclaration) {
    const body = node.body;
    if (body === undefined) {
      return node.declare; // Bodyless modules require ambient declaration syntax.
    }
    node = body;
  }
  switch (node.type) {
    case types.TSModuleBlock: {
      const cached = erasedNamespaces.get(node);
      if (cached !== undefined) {
        return cached;
      }
      // A bare import alias does not instantiate its enclosing namespace.
      const isErased = node.body.every(
        (statement) =>
          statement.type === types.TSImportEqualsDeclaration || isErasedNamespace(statement),
      );
      erasedNamespaces.set(node, isErased);
      return isErased;
    }
    case types.ExportNamedDeclaration: {
      return node.declaration !== null && isErasedNamespace(node.declaration);
    }
    default: {
      return (
        node.type === types.TSTypeAliasDeclaration || node.type === types.TSInterfaceDeclaration
      );
    }
  }
}

function isRuntimeDefinition(definition: Scope.Definition): boolean {
  return (
    !('isVariableDefinition' in definition && definition.isVariableDefinition === false) &&
    !isErasedNamespace(definition.node as unknown as AST.Node)
  );
}

function isVariableDefinition(definition: Scope.Definition): boolean {
  return (
    definition.type === 'Variable' &&
    (definition.parent as unknown as AST.VariableDeclaration).kind === 'var'
  );
}

function directiveStatements(node: AST.Node): readonly AST.Node[] | undefined {
  switch (node.type) {
    case types.Program: {
      return node.body;
    }
    case types.FunctionDeclaration:
    case types.FunctionExpression:
    case types.ArrowFunctionExpression:
    case types.TSModuleDeclaration: {
      const body = node.body;
      return body?.type === types.BlockStatement || body?.type === types.TSModuleBlock
        ? body.body
        : undefined;
    }
    default:
  }
  return undefined;
}

function directiveString(statement: AST.ExpressionStatement): string | undefined {
  const expression = unwrap(statement.expression);
  // Among valid expressions, only a string literal has a string-valued value.
  const literal = expression as Partial<AST.StringLiteral>;
  return typeof literal.value === 'string' &&
    (expression !== statement.expression || statement.range[0] === expression.range[0])
    ? literal.raw
    : undefined;
}

// Actual directives are already strict in parser metadata; erased prefixes or
// wrappers can make emitters disagree. Both cases retain the parser's mode.
function hasPossibleStrictDirective(node: AST.Node): boolean {
  const body = directiveStatements(node);
  if (body === undefined) {
    return false;
  }
  for (const statement of body) {
    if (isTypeOnly(statement)) {
      continue;
    }
    if (statement.type !== types.ExpressionStatement) {
      return false;
    }
    const raw = directiveString(statement);
    if (raw === undefined) {
      return false;
    }
    if (["'use strict'", '"use strict"'].includes(raw)) {
      return true;
    }
  }
  return false;
}

function scopeStrictness(scope: Scope.Scope, parent: boolean | undefined): boolean | undefined {
  if (
    parent === true ||
    scope.type === 'class' ||
    scope.type === 'module' ||
    (scope.type === 'global' && scope.isStrict)
  ) {
    return true;
  }
  return parent === undefined || hasPossibleStrictDirective(scope.block as unknown as AST.Node)
    ? undefined
    : false;
}

function syntheticVariable(name: string, scope: Scope.Scope): Scope.Variable {
  return {
    name,
    scope,
    defs: [],
    // Stryker disable next-line ArrayDeclaration: Required placeholder metadata; the resolved view supplies all references before analysis.
    references: [],
    // Stryker disable next-line ArrayDeclaration: Required Scope.Variable metadata; synthetic bindings have no declaration identifiers and this list is never read.
    identifiers: [],
  };
}

function isInParameters(block: AST.Node, identifier: Identifier): boolean {
  if (!('params' in block) || block.params.length === 0) {
    return false;
  }
  let current: AST.Node = identifier;
  // Scope references belong to their block, so this ancestry reaches it.
  while (current.parent !== block) {
    current = current.parent as AST.Node;
  }
  const parameters: readonly AST.Node[] = block.params;
  return parameters.includes(current);
}

// Ranges are ordered by start; touching half-open intervals are disjoint.
// Stryker disable next-line EqualityOperator: The >= variant changes grouping only; the reversed <= variant is separately challenged by annotation work and priority tests.
const areOverlapping = (left: AST.Range, right: AST.Range): boolean => left[1] > right[0];

export function createResolver(
  source: SourceCode,
  sourceType: 'script' | 'module' | 'commonjs' | undefined,
): {
  resolve: (node: AST.Node) => Origin | undefined;
  load: (node: AST.Node | null | undefined) => Origin | undefined;
  select: (
    origin: Origin | undefined,
    node: AST.MemberExpression | AST.Property,
  ) => Origin | undefined;
  patternOrigin: (pattern: AST.ObjectPattern) => Origin | undefined;
  binding: (pattern: AST.Node, target: AST.Node, origin: Origin | undefined) => Origin | undefined;
  declaredOrigin: (variable: Scope.Variable) => Origin | undefined;
  isGlobal: (node: Identifier) => boolean;
} {
  const globalScope = source.getScope(source.ast);
  const hoisted = new Map<Scope.Scope, Map<string, Scope.Variable>>();
  const implicitArguments = new Map<Scope.Scope, Scope.Variable>();
  const strictScopes = new Map<Scope.Scope, boolean | undefined>();
  for (const scope of source.scopeManager.scopes) {
    const block = scope.block as unknown as AST.Node;
    const strict = scopeStrictness(
      scope,
      scope.upper === null ? false : strictScopes.get(scope.upper),
    );
    strictScopes.set(scope, strict);
    if (argumentScopes.has(scope.type) && block.type !== types.ArrowFunctionExpression) {
      // Stryker disable next-line StringLiteral: This name is debug metadata; implicit arguments are selected by scope and identifier spelling, not this field.
      implicitArguments.set(scope, syntheticVariable('arguments', scope));
    }
    if ((strict ?? scope.isStrict) || !['block', 'switch'].includes(scope.type)) {
      continue;
    }
    for (const variable of scope.variables) {
      if (variable.defs.every((definition) => definition.type !== 'FunctionName')) {
        continue;
      }
      const names = hoisted.get(scope.variableScope) ?? new Map<string, Scope.Variable>();
      names.set(variable.name, variable);
      hoisted.set(scope.variableScope, names);
    }
  }

  const reassigned = new Map<Scope.Variable, boolean>();
  function isReassigned(variable: Scope.Variable): boolean {
    const cached = reassigned.get(variable);
    if (cached !== undefined) {
      return cached;
    }
    // Multiple runtime declarations have no single origin in this analysis.
    const definition = variable.defs[0];
    const isVariable = definition !== undefined && isVariableDefinition(definition);
    const hasWrites =
      variable.references.some((reference) => {
        const parentType = (reference.writeExpr as unknown as AST.Expression | undefined)?.parent
          .type;
        return (
          reference.isWrite() &&
          (reference.init !== true ||
            parentType === types.ForInStatement ||
            parentType === types.ForOfStatement)
        );
      }) ||
      (isVariable && hoisted.get(variable.scope)?.has(variable.name) === true);
    reassigned.set(variable, hasWrites);
    return hasWrites;
  }

  function referencedVariable(reference: Scope.Reference): Scope.Variable | undefined {
    const identifier = reference.identifier as unknown as AST.Identifier;
    let resolved = reference.resolved;
    // Intermediate scopes matter only for hoisted functions and implicit arguments.
    const start =
      hoisted.size === 0 && identifier.name !== 'arguments' ? resolved?.scope : reference.from;
    for (let scope = start; scope !== undefined; scope = scope.upper ?? undefined) {
      const isParameterReference = isInParameters(scope.block as unknown as AST.Node, identifier);
      if (scope === resolved?.scope && resolved.defs.length > 0) {
        if (
          !isParameterReference ||
          resolved.defs.some((definition) => definition.node === scope.block)
        ) {
          return resolved;
        }
        // Parameter environments have a parent; body declarations are invisible here.
        resolved = findVariable(scope.upper as Scope.Scope, identifier.name);
      }
      const extra =
        (isParameterReference ? undefined : hoisted.get(scope)?.get(identifier.name)) ??
        (identifier.name === 'arguments' ? implicitArguments.get(scope) : undefined);
      if (extra !== undefined) {
        return extra;
      }
    }
    return resolved ?? undefined;
  }
  const staticScope = Object.create(globalScope) as Scope.Scope;
  const missingGlobals = new Map<string, Scope.Variable>();
  const effectiveReferences = new Map<Scope.Variable, Set<Scope.Reference>>();

  function outerValue(variable: Scope.Variable, name: string): Scope.Variable | undefined {
    for (let scope: Scope.Scope | null = variable.scope; scope !== null; scope = scope.upper) {
      const extra =
        hoisted.get(scope)?.get(name) ??
        (name === 'arguments' ? implicitArguments.get(scope) : undefined);
      if (extra !== undefined) {
        return extra;
      }
      const outer = scope.upper?.set.get(name);
      if (outer !== undefined) {
        return outer;
      }
    }
    return undefined;
  }

  function runtimeTarget(original: Scope.Variable | undefined, name: string): Scope.Variable {
    let variable = original;
    while (variable !== undefined) {
      if (
        variable.defs.length === 0 ||
        variable.defs.some((definition) => isRuntimeDefinition(definition))
      ) {
        return variable;
      }
      variable = outerValue(variable, name);
    }
    let missing = missingGlobals.get(name);
    if (missing === undefined) {
      missing = syntheticVariable(name, globalScope);
      missingGlobals.set(name, missing);
    }
    return missing;
  }

  // Erased TypeScript symbols can own references to a surviving outer value.
  // Rehome those references before evaluating any binding, including later
  // reads whose original scope metadata does not contain the hidden writes.
  const allReferences = source.scopeManager.scopes.flatMap((scope) => scope.references);
  const references = new Map<unknown, Scope.Reference>();
  for (const reference of allReferences) {
    references.set(reference.identifier, reference);
    const target = runtimeTarget(referencedVariable(reference), reference.identifier.name);
    const collected = effectiveReferences.get(target) ?? new Set<Scope.Reference>();
    collected.add(reference);
    effectiveReferences.set(target, collected);
  }

  function isInitializerOwner(definition: Scope.Definition): boolean {
    const owner = references.get(definition.name)?.resolved;
    return owner?.defs.includes(definition) !== false;
  }

  function isSelfInitializer(variable: Scope.Variable, definition: Scope.Definition): boolean {
    const declaration = definition.node as unknown as AST.VariableDeclarator;
    if (declaration.id.type !== types.Identifier || declaration.init === null) {
      return false;
    }
    const value = unwrap(declaration.init);
    if (value.type !== types.Identifier) {
      return false;
    }
    // Identifier initializers are value references; identity excludes dynamic lookups.
    const reference = references.get(value) as Scope.Reference;
    return !hasDynamicLookup(reference) && reference.resolved === variable;
  }

  // The reference prepass is complete before any immutable view is requested.
  const normalized = new Map<Scope.Variable, Scope.Variable>();
  function runtimeVariable(original: Scope.Variable | undefined, name: string): Scope.Variable {
    const target = runtimeTarget(original, name);
    const cached = normalized.get(target);
    if (cached !== undefined) {
      return cached;
    }
    const definitions = target.defs.filter((definition) => isRuntimeDefinition(definition));
    const inertInitializers = new Set<unknown>(
      definitions
        .filter(
          (definition) => isVariableDefinition(definition) && isSelfInitializer(target, definition),
        )
        .map((definition) => (definition.node as unknown as AST.VariableDeclarator).init),
    );
    const bindings = definitions.filter(
      (definition) =>
        !isVariableDefinition(definition) ||
        ((definition.node as unknown as AST.VariableDeclarator).init !== null &&
          !inertInitializers.has((definition.node as unknown as AST.VariableDeclarator).init) &&
          isInitializerOwner(definition)),
    );
    // Bare var redeclarations preserve existing globals and Node wrapper parameters.
    const hasImplicitBinding =
      (sourceType === 'script' && target.scope.type === 'global') ||
      (sourceType === 'commonjs' &&
        target.scope.block.type === 'Program' &&
        ['require', 'module', 'exports'].includes(name));
    const defs = hasImplicitBinding || bindings.length > 0 ? bindings : definitions;
    const result = Object.create(target) as Scope.Variable;
    Object.defineProperties(result, {
      defs: { value: defs },
      references: {
        // A loop's iteration writes have their own RHS node and remain visible.
        value: [...(effectiveReferences.get(target) ?? target.references)].filter(
          (reference) => !inertInitializers.has(reference.writeExpr),
        ),
      },
    });
    normalized.set(target, result);
    return result;
  }

  // eslint-utils reevaluates constant initializers with its original scope.
  // Reference frames preserve each identifier's resolved binding even when
  // its declaration or a parameter initializer belongs to another scope.
  const makeFrames = (): Scope.Scope[] =>
    Array.from(references.values(), (reference) => {
      const variable = runtimeVariable(referencedVariable(reference), reference.identifier.name);
      const frame = Object.create(globalScope) as Scope.Scope;
      Object.defineProperties(frame, {
        block: { value: reference.identifier },
        set: {
          value: new Map(
            hasDynamicLookup(reference) || isReassigned(variable)
              ? []
              : [[reference.identifier.name, variable]],
          ),
        },
        childScopes: { value: [] },
      });
      return frame;
    });
  const range = (scope: Scope.Scope): AST.Range => (scope.block as unknown as AST.Node).range;
  const groupFrame = (bounds: AST.Range, childScopes: Scope.Scope[]): Scope.Scope =>
    Object.create(globalScope, {
      block: { value: { range: bounds } },
      childScopes: { value: childScopes },
    }) as Scope.Scope;
  function overlapGroups(frames: Scope.Scope[], sorted: Scope.Scope[]): Scope.Scope[] {
    const positions = new Map(frames.map((frame, index) => [frame, index]));
    const groups: { bounds: AST.Range; scopes: Scope.Scope[] }[] = [];
    for (const frame of sorted) {
      const last = groups.at(-1);
      if (last !== undefined && areOverlapping(last.bounds, range(frame))) {
        last.scopes.push(frame);
        last.bounds[1] = Math.max(last.bounds[1], range(frame)[1]);
      } else {
        groups.push({ bounds: [...range(frame)], scopes: [frame] });
      }
    }
    return groups.map(({ bounds, scopes }) =>
      scopes.length === 1
        ? (scopes[0] as Scope.Scope)
        : groupFrame(
            bounds,
            scopes.toSorted(
              (left, right) => (positions.get(left) as number) - (positions.get(right) as number),
            ),
          ),
    );
  }
  function indexFrames(frames: Scope.Scope[], isOrdered = false): Scope.Scope[] {
    if (frames.length <= 8) {
      return frames;
    }
    let sorted = isOrdered
      ? frames
      : frames.toSorted((left, right) => range(left)[0] - range(right)[0]);
    // Type annotations can overlap references; preserve the parser's priority.
    if (
      !isOrdered &&
      sorted.some(
        (scope, index) =>
          index > 0 && areOverlapping(range(sorted[index - 1] as Scope.Scope), range(scope)),
      )
    ) {
      sorted = overlapGroups(frames, sorted);
      if (sorted.length <= 8) {
        return sorted;
      }
    }
    const middle = Math.ceil(sorted.length / 2);
    return [sorted.slice(0, middle), sorted.slice(middle)].map((childScopes) => {
      const bounds: AST.Range = [
        range(childScopes[0] as Scope.Scope)[0],
        range(childScopes.at(-1) as Scope.Scope)[1],
      ];
      return groupFrame(bounds, indexFrames(childScopes, true));
    });
  }
  let children: Scope.Scope[] | undefined;
  Object.defineProperties(staticScope, {
    childScopes: {
      get: () => {
        children ??= indexFrames(makeFrames());
        return children;
      },
    },
  });
  const key = (node: AST.MemberExpression | AST.Property): string | null | undefined =>
    getPropertyName(node as unknown as Parameters<typeof getPropertyName>[0], staticScope);
  const select = (
    origin: Origin | undefined,
    node: AST.MemberExpression | AST.Property,
  ): Origin | undefined => (origin === undefined ? undefined : member(origin, key(node)));
  function isThenMember(callee: AST.CallExpression['callee']): callee is AST.MemberExpression {
    // Other valid callee kinds have no property name; eslint-utils returns null.
    return key(callee as AST.MemberExpression) === 'then';
  }
  // eslint-utils treats missing nodes as unknown, including local exports and require().
  const load = (node: AST.Node | null | undefined, isBuiltinOnly = false): Origin | undefined =>
    moduleOrigin(getStringIfConstant(node as unknown as Rule.Node, staticScope), isBuiltinOnly);

  function variableOf(node: Identifier): Scope.Variable {
    // Only reference expressions reach this helper; declarations use declaredOrigin.
    const reference = references.get(node) as Scope.Reference;
    return 'isTypeReference' in reference &&
      reference.isTypeReference === true &&
      reference.resolved?.defs.every((definition) => !isRuntimeDefinition(definition)) === true
      ? reference.resolved
      : runtimeVariable(referencedVariable(reference), node.name);
  }

  function callbackInput(callback: AST.Node, seen: Set<AST.Node>): Origin | undefined {
    switch (callback.type) {
      case types.ArrowFunctionExpression:
      case types.FunctionExpression: {
        const value = callbackValue(callback);
        const call = value.parent;
        if (call.type !== types.CallExpression || call.arguments[0] !== value) {
          return undefined;
        }
        const callee = unwrap(call.callee);
        if (isThenMember(callee)) {
          return promiseValue(resolve(callee.object, seen));
        }
        break;
      }
      default:
    }
    return undefined;
  }

  function parameterInput(
    declaration: AST.ArrowFunctionExpression | AST.FunctionExpression | AST.FunctionDeclaration,
    parameter: AST.Parameter,
    seen: Set<AST.Node>,
  ): Origin {
    const first = declaration.params.find(
      (candidate) => (candidate as Partial<AST.Identifier>).name !== 'this',
    );
    return first === parameter ? (callbackInput(declaration, seen) ?? absent) : absent;
  }

  function patternOrigin(pattern: AST.ObjectPattern | AST.AssignmentPattern): Origin | undefined {
    const parent = pattern.parent;
    switch (parent.type) {
      case types.VariableDeclarator: {
        return parent.init === null ? undefined : resolve(parent.init);
      }
      case types.AssignmentExpression: {
        return resolve(parent.right);
      }
      case types.AssignmentPattern: {
        const primary = patternOrigin(parent);
        return primary === absent ? resolve(parent.right) : primary;
      }
      case types.Property: {
        // A property whose value is an ObjectPattern belongs to a containing pattern.
        return select(patternOrigin(parent.parent as AST.ObjectPattern), parent);
      }
      default: {
        return parent.type === types.ArrowFunctionExpression ||
          parent.type === types.FunctionExpression ||
          parent.type === types.FunctionDeclaration
          ? parameterInput(parent, pattern, new Set())
          : undefined;
      }
    }
  }

  function binding(
    pattern: AST.Node,
    target: AST.Node,
    origin: Origin | undefined,
    seen = new Set<AST.Node>(),
  ): Origin | undefined {
    let current = pattern.type === types.TSParameterProperty ? pattern.parameter : pattern;
    let value = origin;
    while (current.type === types.AssignmentPattern) {
      if (value === absent) {
        value = resolve(current.right, seen);
      }
      current = current.left;
    }
    if (current === target) {
      return value;
    }
    if (value === undefined) {
      return undefined;
    }
    let property = target;
    // Binding targets belong to their pattern, including array and rest targets.
    while (property.parent !== current) {
      property = property.parent as AST.Node;
    }
    return property.type === types.Property
      ? binding(property.value, target, member(value, key(property)), seen)
      : undefined;
  }

  function definitionOrigin(definition: Scope.Definition, seen: Set<AST.Node>): Origin | undefined {
    const declaration = definition.node as unknown as AST.Node;
    if (isTypeOnly(declaration)) {
      return undefined;
    }
    const target = definition.name as unknown as AST.Node;
    switch (declaration.type) {
      case types.ImportSpecifier: {
        return namespaceMember(load(declaration.parent.source), symbolName(declaration.imported));
      }
      case types.ImportNamespaceSpecifier: {
        return namespace(load(declaration.parent.source)) ?? opaque;
      }
      case types.ImportDefaultSpecifier: {
        return load(declaration.parent.source);
      }
      case types.TSImportEqualsDeclaration: {
        return resolve(declaration.moduleReference, seen);
      }
      case types.VariableDeclarator: {
        const reference = references.get(target);
        if (hasDynamicLookup(reference) || !isInitializerOwner(definition)) {
          return opaque;
        }
        return declaration.init === null
          ? undefined
          : binding(declaration.id, target, resolve(declaration.init, seen), seen);
      }
      case types.ArrowFunctionExpression:
      case types.FunctionDeclaration:
      case types.FunctionExpression: {
        const parameter =
          definition.type === 'Parameter'
            ? declaration.params.find((candidate) => candidate.range[1] >= target.range[1])
            : undefined;
        return parameter === undefined
          ? undefined
          : binding(parameter, target, parameterInput(declaration, parameter, seen), seen);
      }
      default:
    }
    return undefined;
  }

  function hasDynamicLookup(reference: Scope.Reference | undefined): boolean {
    const boundScope = reference?.resolved?.scope;
    for (let scope = reference?.from; scope !== undefined; scope = scope.upper ?? undefined) {
      if (scope === boundScope) {
        return false;
      }
      if (scope.type === 'with') {
        return true;
      }
    }
    return false;
  }

  function isGlobal(node: Identifier): boolean {
    const reference = references.get(node);
    if (
      reference === undefined ||
      ('isValueReference' in reference && reference.isValueReference === false)
    ) {
      return false;
    }
    const variable = variableOf(node);
    return (
      !hasDynamicLookup(reference) &&
      variable.defs.every(
        (definition) =>
          sourceType === 'script' &&
          variable.scope.type === 'global' &&
          isVariableDefinition(definition),
      )
    );
  }

  function bindingOrigin(variable: Scope.Variable, seen: Set<AST.Node>): Origin | undefined {
    if (variable.defs.length > 1 || isReassigned(variable)) {
      return undefined;
    }
    const definition = variable.defs.at(0);
    return definition === undefined
      ? globals.get(variable.name)
      : definitionOrigin(definition, seen);
  }

  function identifierOrigin(node: Identifier, seen: Set<AST.Node>): Origin | undefined {
    return hasDynamicLookup(references.get(node)) ? opaque : bindingOrigin(variableOf(node), seen);
  }

  function declaredOrigin(variable: Scope.Variable): Origin | undefined {
    return bindingOrigin(runtimeVariable(variable, variable.name), new Set());
  }

  function resolve(input: AST.Node, seen = new Set<AST.Node>()): Origin | undefined {
    let node = unwrap(input);
    // Among valid expression nodes, only AssignmentExpression has operator '='.
    while ((node as Partial<AST.AssignmentExpression>).operator === '=') {
      node = unwrap((node as AST.AssignmentExpression).right);
    }
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    // Only active ancestors are cyclic; defaults may reuse a completed alias.
    try {
      switch (node.type) {
        case types.Identifier:
        case types.JSXIdentifier: {
          return references.has(node) ? identifierOrigin(node, seen) : undefined;
        }
        case types.JSXMemberExpression: {
          return member(resolve(node.object, seen), node.property.name);
        }
        case types.MemberExpression: {
          return select(resolve(node.object, seen), node);
        }
        case types.TSQualifiedName: {
          return member(resolve(node.left, seen), node.right.name);
        }
        case types.TSExternalModuleReference: {
          return load(node.expression);
        }
        case types.ImportExpression: {
          return promise(namespace(load(node.source)) ?? opaque);
        }
        case types.AwaitExpression: {
          const origin = resolve(node.argument, seen);
          return promiseValue(origin) ?? origin;
        }
        case types.NewExpression:
        case types.CallExpression: {
          const callee = resolve(node.callee, seen);
          if (callee === loaderFactory) {
            return loader;
          }
          const [argument] = node.arguments;
          if (callee === loader || callee === builtinLoader) {
            return load(argument, callee === builtinLoader);
          }
          return node.type === types.NewExpression ? instances.get(callee) : undefined;
        }
        case types.AssignmentExpression: {
          return isValueAssignment(node.operator)
            ? commonOrigin(node.left, node.right, seen)
            : undefined;
        }
        case types.SequenceExpression: {
          // A valid sequence always contains expressions.
          return resolve(node.expressions.at(-1) as AST.Expression, seen);
        }
        case types.ConditionalExpression: {
          return commonOrigin(node.consequent, node.alternate, seen);
        }
        case types.LogicalExpression: {
          return commonOrigin(node.left, node.right, seen);
        }
        default:
      }
      return undefined;
    } finally {
      seen.delete(node);
    }
  }

  function commonOrigin(left: AST.Node, right: AST.Node, seen: Set<AST.Node>): Origin | undefined {
    const first = resolve(left, seen);
    return first === undefined ? undefined : common(first, resolve(right, seen));
  }
  return { resolve, load, select, patternOrigin, binding, declaredOrigin, isGlobal };
}
