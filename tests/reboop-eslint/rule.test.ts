import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import plugin from '../../packages/reboop-eslint/src/index.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();
ruleTester.run('require-client', plugin.rules['require-client'], {
  valid: [
    /**
    Local names must not be treated as native transports.
    */
    "function use(fetch) { fetch('/items'); }",
    /**
    Client calls must remain legal without naming conventions.
    */
    "api.json('/items');",
  ],
  invalid: [
    /**
    Pin the identifier range so aliases cannot hide the acquisition site.
    */
    {
      code: 'const send = fetch;',
      errors: [{ messageId: 'useReboop', line: 1, column: 14, endLine: 1, endColumn: 19 }],
    },
    /**
    Pin the whole global member, including the Worker/global root.
    */
    {
      code: 'self.fetch;',
      errors: [{ messageId: 'useReboop', line: 1, column: 1, endLine: 1, endColumn: 11 }],
    },
  ],
  assertionOptions: { requireMessage: true, requireLocation: true },
});
