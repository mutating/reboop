import { describe, expect, it } from 'vitest';
import { common, transport } from '../../packages/reboop-eslint/src/transports.js';
import type { Origin } from '../../packages/reboop-eslint/src/transports.js';
import { lint } from './lint.js';

const modules = "import{Agent}from'undici';const Module=require('node:module');";

describe('constructor and prototype origin integration regressions', () => {
  /**
  Agent instances and Agent.prototype inherit the actual Agent constructor.
  Following that constructor must retain the dispatcher origin after another
  construction, through destructuring, static keys and unchanged aliases.
  Native Undici execution independently confirmed constructor and method
  identity; every created Agent was closed without sending a request.
  */
  it.each([
    "import{Agent}from'undici';new (Agent.prototype.constructor)().request;",
    "import{Agent}from'undici';const first=new Agent();new first.constructor().dispatch;",
    "import{Agent}from'undici';const {constructor:Again}=Agent.prototype;new Again().stream;",
    "import{Agent}from'undici';const first=new Agent();const {constructor:Again}=first;new Again().pipeline;",
    "const{Agent}=require('undici');const Again=Agent.prototype.constructor;new Again().connect;",
    "import{Agent}from'undici';const key='constructor';const Again=Agent.prototype[key];new Again().request;",
    "import{Agent}from'undici';Agent.prototype.constructor.prototype.request;",
    "import{Agent}from'undici';const Again=flag?Agent.prototype.constructor:Agent;new Again().request;",
    "import{Agent}from'undici';const first=new Agent();const Again=flag?Agent.prototype.constructor:first.constructor;new Again().dispatch;",
    "import{Agent}from'undici';const first=new Agent();const root=flag?Agent.prototype:first;new root.constructor().request;",
  ])('retains the Agent constructor origin: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Module and Agent have different constructor/prototype cycles. Intersecting
  their origins must terminate without inventing an agreed HTTP method. Both
  branch orders, constructors, prototypes and instances exercise repeated
  origin pairs through the real ESLint entry point. The last case intentionally
  keeps the documented unknown-branch boundary: request is not shared by both
  possible constructors, so its later read has no single proven origin.
  */
  it.each([
    'const root=flag?Module.prototype:Agent.prototype;root.constructor;',
    'const root=flag?Agent.prototype:Module.prototype;root.constructor;',
    'const root=flag?new Module():new Agent();root.constructor;',
    'const root=flag?Module:Agent;root.prototype.constructor;',
    'const root=flag?Module.prototype:Agent.prototype;root.constructor.prototype;',
    'const root=flag?Module.prototype:Agent.prototype;new root.constructor().request;',
  ])('terminates on incompatible cyclic origins: %s', async (code) => {
    const result = await lint(modules + code);
    expect(result.messages).toEqual([]);
  });

  /**
  Constructor references and dispatcher lifecycle helpers remain allowed.
  Diagnosing every constructor or every member of a reconstructed Agent would
  reject safe cleanup and harmless constructor acquisition. These cases guard
  the distinction between the constructor role and HTTP transport methods.
  */
  it.each([
    "import{Agent}from'undici';new (Agent.prototype.constructor)().close;",
    "import{Agent}from'undici';const first=new Agent();new first.constructor().destroy;",
    "import{Agent}from'undici';Agent.prototype.constructor;",
  ])('keeps constructors and lifecycle helpers allowed: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  A familiar Agent spelling does not establish a native dispatcher identity.
  Local classes, local object members and imports from application modules can
  expose their own constructor and request methods. The integration cases reject
  a name-based constructor fix that would misclassify these clients.
  */
  it.each([
    'const Agent=class{request(){}};new Agent.prototype.constructor().request;',
    'const local={Agent:class{dispatch(){}}};const{Agent}=local;const first=new Agent();new first.constructor().dispatch;',
    "import{Agent}from'./client.js';new Agent.prototype.constructor().request;",
  ])('keeps local constructor-shaped clients local: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Only agreeing branch origins may identify a reconstructed dispatcher. An
  unknown application client on either side keeps the constructor unknown;
  dropping that branch would manufacture a proven transport and false report.
  */
  it.each([
    "import{Agent}from'undici';import{Local}from'./client.js';const Again=flag?Agent.prototype.constructor:Local;new Again().request;",
    "import{Agent}from'undici';import{Local}from'./client.js';const Again=flag?Local:Agent.prototype.constructor;new Again().request;",
  ])('preserves an unknown branch: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });
});

describe('cyclic origin intersections', () => {
  /**
  Intersecting distinct cyclic graphs must retain shared transport fields and
  their back-reference identity. Cutting every repeated pair to unknown would
  terminate recursion but lose a real transport reachable through self again.
  */
  it('retains a shared transport through a cyclic self-reference', () => {
    const left: Origin = new Map([['request', transport]]);
    const right: Origin = new Map([['request', transport]]);
    left.set('self', left);
    right.set('self', right);
    const result = common(left, right);
    expect(result?.get('request')).toBe(transport);
    expect(result?.get('self')).toBe(result);
    expect(result?.size).toBe(2);
  });

  /**
  A completed empty intersection means unknown, even when the same incompatible
  leaf pair appears under another field. Fresh empty maps keep this independent
  of metadata added to real loader functions. Retaining the construction
  placeholder would manufacture a known origin for the second field.
  */
  it('keeps repeated incompatible leaf roles unknown', () => {
    const leftLeaf: Origin = new Map();
    const rightLeaf: Origin = new Map();
    const left: Origin = new Map([
      ['first', leftLeaf],
      ['second', leftLeaf],
    ]);
    const right: Origin = new Map([
      ['first', rightLeaf],
      ['second', rightLeaf],
    ]);
    expect(common(left, right)).toBeUndefined();
  });
});
