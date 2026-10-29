import { AST_NODE_TYPES as types } from '@typescript-eslint/types';
import type { TSESTree as AST } from '@typescript-eslint/types';
import type { Linter, Rule } from 'eslint';
import { createResolver, isTypeOnly, isValueAssignment, symbolName } from './origin.js';
import {
  exportsObject,
  globals,
  namespaceMember,
  isNetwork,
  isNamespace,
  transport,
} from './transports.js';
import type { Origin } from './transports.js';

const requireClient: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Require HTTP requests through reboop' },
    schema: [],
    messages: {
      useReboop:
        'Use the shared reboop client for HTTP requests. Consistent retries and timeouts protect API calls when DNS addresses have uneven geographic availability; retries cannot guarantee a different IP. Exclude only dedicated transport adapter files in your ESLint config.',
    },
  },
  create(context) {
    if (/\.d\.[cm]?ts$/u.test(context.filename)) {
      return {};
    }
    const { resolve, load, select, patternOrigin, binding, declaredOrigin, isGlobal } =
      createResolver(context.sourceCode, context.languageOptions.sourceType);
    function report(node: AST.Node): void {
      context.report({ node, messageId: 'useReboop' });
    }
    function reportTransport(node: AST.Node, origin: Origin | undefined): void {
      if (origin === transport) {
        report(node);
      }
    }
    function visit<T extends AST.Node>(check: (node: T) => void): (raw: Rule.Node | T) => void {
      return (raw): void => {
        const node = raw as unknown as T;
        if (!isTypeOnly(node)) {
          check(node);
        }
      };
    }
    return {
      Identifier(raw): void {
        const node = raw as unknown as AST.Identifier;
        if (globals.get(node.name) === transport && !isTypeOnly(node) && isGlobal(node)) {
          report(node);
        }
      },
      'MemberExpression, CallExpression, NewExpression': visit((node) => {
        reportTransport(node, resolve(node));
      }),
      JSXOpeningElement: visit<AST.JSXOpeningElement>((node) => {
        let name = node.name;
        while (name.type === types.JSXMemberExpression) {
          reportTransport(name, resolve(name));
          name = name.object;
        }
        reportTransport(name, resolve(name));
      }),
      ImportExpression: visit<AST.ImportExpression>((node) => {
        reportTransport(node, load(node.source));
      }),
      ImportDeclaration: visit<AST.ImportDeclaration>((node) => {
        if (
          load(node.source) === transport &&
          (node.specifiers.length === 0 ||
            node.specifiers.some((specifier) => !isTypeOnly(specifier)))
        ) {
          report(node);
        }
      }),
      ImportSpecifier: visit<AST.ImportSpecifier>((node) => {
        const origin = load(node.parent.source);
        reportTransport(node, namespaceMember(origin, symbolName(node.imported)));
      }),
      TSImportEqualsDeclaration: visit<AST.TSImportEqualsDeclaration>((node) => {
        reportTransport(node, resolve(node.moduleReference));
      }),
      ExportAllDeclaration: visit<AST.ExportAllDeclaration>((node) => {
        if (isNetwork(load(node.source))) {
          report(node);
        }
      }),
      ExportNamedDeclaration: visit<AST.ExportNamedDeclaration>((node) => {
        const origin = load(node.source);
        const declaration = node.declaration;
        if (isTypeOnly(declaration)) {
          return;
        }
        if (
          declaration?.type === types.TSImportEqualsDeclaration &&
          isNamespace(resolve(declaration.moduleReference))
        ) {
          report(node);
          return;
        }
        if (declaration?.type === types.VariableDeclaration) {
          const variables = context.sourceCode.getDeclaredVariables(
            declaration as unknown as Rule.Node,
          );
          if (variables.some((variable) => isNamespace(declaredOrigin(variable)))) {
            report(node);
            return;
          }
        }
        if (
          (origin === transport && node.specifiers.length === 0) ||
          node.specifiers.some((specifier) => {
            if (isTypeOnly(specifier)) {
              return false;
            }
            if (node.source === null) {
              return isNamespace(resolve(specifier.local));
            }
            return (
              origin === transport ||
              isNetwork(namespaceMember(origin, symbolName(specifier.local)))
            );
          })
        ) {
          report(node);
        }
      }),
      AssignmentExpression: visit<AST.AssignmentExpression>((node) => {
        if (
          isValueAssignment(node.operator) &&
          resolve(node.left) === exportsObject &&
          isNamespace(resolve(node.right))
        ) {
          report(node);
        }
      }),
      'ExportDefaultDeclaration, TSExportAssignment': visit<
        AST.ExportDefaultDeclaration | AST.TSExportAssignment
      >((node) => {
        if (
          isNamespace(
            resolve(
              node.type === types.ExportDefaultDeclaration ? node.declaration : node.expression,
            ),
          )
        ) {
          report(node);
        }
      }),
      Property(raw): void {
        const node = raw as unknown as AST.Property;
        if (node.parent.type !== types.ObjectPattern || isTypeOnly(node)) {
          return;
        }
        const origin = select(patternOrigin(node.parent), node);
        if (origin === undefined) {
          return;
        }
        let target = node.value;
        while (target.type === types.AssignmentPattern) {
          target = target.left;
        }
        if (
          origin === transport ||
          (resolve(target) === exportsObject && isNamespace(binding(node.value, target, origin)))
        ) {
          report(node);
        }
      },
    };
  },
};

const plugin = {
  meta: { name: 'reboop-eslint', namespace: 'reboop' },
  rules: { 'require-client': requireClient },
  configs: {} as { recommended: Linter.Config },
};

plugin.configs.recommended = {
  name: 'reboop/recommended',
  plugins: { reboop: plugin },
  rules: { 'reboop/require-client': 'error' },
};

export default plugin;
