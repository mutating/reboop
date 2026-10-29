import path from 'node:path';

export type Origin = Map<string, Origin>;

export const transport: Origin = new Map();
export const loader: Origin = new Map();
export const builtinLoader: Origin = new Map();
export const loaderFactory: Origin = new Map();
export const exportsObject: Origin = new Map();
export const absent: Origin = new Map();
export const opaque: Origin = new Map();
for (const role of [loader, builtinLoader, loaderFactory]) {
  role.set('prototype', new Map([['constructor', role]]));
}
const nodeProcess: Origin = new Map([['getBuiltinModule', builtinLoader]]);
const nodeModule: Origin = new Map([['createRequire', loaderFactory]]);
const moduleInstance: Origin = new Map([
  ['require', loader],
  ['constructor', nodeModule],
]);
nodeModule.set('Module', nodeModule);
nodeModule.set('prototype', moduleInstance);
const globalObject = new Map<string, Origin>([
  ['fetch', transport],
  ['XMLHttpRequest', transport],
  ['process', nodeProcess],
]);
for (const name of ['globalThis', 'window', 'self', 'global']) {
  globalObject.set(name, globalObject);
}
export const globals = new Map(globalObject);
globals.set('require', loader);
globals.set('module', new Map([...moduleInstance, ['exports', exportsObject]]));
globals.set('exports', exportsObject);

const https: Origin = new Map([
  ['request', transport],
  ['get', transport],
]);
const http: Origin = new Map([...https, ['ClientRequest', transport]]);
const undici: Origin = new Map(
  ['fetch', 'request', 'stream', 'pipeline', 'connect', 'Client', 'Pool', 'BalancedPool'].map(
    (name) => [name, transport],
  ),
);
for (const origin of [http, https, undici, nodeModule, nodeProcess]) {
  origin.set('default', absent);
  origin.set('module.exports', absent);
}
const agent: Origin = new Map();
const dispatcher: Origin = new Map(
  ['request', 'stream', 'pipeline', 'connect', 'dispatch'].map((name) => [name, transport]),
);
undici.set('Agent', agent);
agent.set('prototype', dispatcher);
dispatcher.set('constructor', agent);
export const instances = new Map<Origin | undefined, Origin>([
  [agent, dispatcher],
  [nodeModule, moduleInstance],
]);
// Node namespaces expose different fields from their raw default values.
const namespaceOverrides = new Map<Origin, Origin>([
  [nodeModule, new Map([['prototype', absent]])],
  [undici, new Map([['module.exports', undici]])],
]);
// Read-only weak collection lookups accept undefined as an absent origin;
// add/set keys remain constrained to Origin.
const networkModules: WeakSet<Origin> & {
  has(value: Origin | undefined): boolean;
} = new WeakSet<Origin>([http, https, undici, transport]);
export function isNetwork(origin: Origin | undefined): boolean {
  return networkModules.has(origin);
}

export function isNamespace(origin: Origin | undefined): boolean {
  return origin !== transport && isNetwork(origin);
}

const fulfilled: WeakMap<Origin, Origin> & {
  get(value: Origin | undefined): Origin | undefined;
} = new WeakMap<Origin, Origin>();

export function namespace(origin: Origin | undefined): Origin | undefined {
  if (origin === undefined || origin === transport) {
    return origin;
  }
  const result = new Map([
    ...origin,
    ...(namespaceOverrides.get(origin) ?? []),
    ['default', origin],
  ]);
  if (isNetwork(origin)) {
    networkModules.add(result);
  }
  return result;
}

export function namespaceMember(origin: Origin | undefined, key: string): Origin | undefined {
  if (origin === undefined || origin === transport) {
    return member(origin, key);
  }
  return key === 'default' ? origin : (namespaceOverrides.get(origin)?.get(key) ?? origin.get(key));
}

export function promise(origin: Origin): Origin {
  const result: Origin = new Map();
  fulfilled.set(result, origin);
  if (isNamespace(origin)) {
    networkModules.add(result);
  }
  return result;
}

export function promiseValue(origin: Origin | undefined): Origin | undefined {
  return fulfilled.get(origin);
}

// Conditional values retain only fields whose origins agree on both paths.
export function common(
  left: Origin | undefined,
  right: Origin | undefined,
  intersections = new Map<Origin, Map<Origin, Origin | undefined>>(),
): Origin | undefined {
  if (left === right) {
    return left;
  }
  if (
    (left === loader && right === builtinLoader) ||
    (left === builtinLoader && right === loader)
  ) {
    return builtinLoader;
  }
  if (left === undefined || right === undefined) {
    return undefined;
  }
  const first = promiseValue(left);
  if (first !== undefined) {
    const second = promiseValue(right);
    // Two imports still supply a namespace even when no known fields agree.
    return second === undefined
      ? undefined
      : promise(common(first, second, intersections) ?? opaque);
  }
  const matches = intersections.get(left) ?? new Map<Origin, Origin | undefined>();
  if (matches.has(right)) {
    return matches.get(right);
  }
  const result: Origin = new Map();
  // Constructor/prototype graphs can revisit a pair before its fields are complete.
  matches.set(right, result);
  intersections.set(left, matches);
  for (const [name, origin] of left) {
    const value = common(origin, right.get(name), intersections);
    if (value !== undefined) {
      result.set(name, value);
    }
  }
  if (result.size === 0) {
    matches.set(right, undefined);
    return undefined;
  }
  if (isNetwork(left) && isNetwork(right)) {
    networkModules.add(result);
  }
  return result;
}

const modules = new Map<string, Origin>([
  ['http', http],
  ['https', https],
  ['node:http', http],
  ['node:https', https],
  ['undici', undici],
  ['module', nodeModule],
  ['node:module', nodeModule],
  ['process', nodeProcess],
  ['node:process', nodeProcess],
]);
const transportPackages = new Set([
  'node-fetch',
  'cross-fetch',
  'isomorphic-fetch',
  'axios',
  'ky',
  'got',
]);

export function moduleOrigin(name: string | null, isBuiltinOnly: boolean): Origin | undefined {
  if (name === null) {
    return undefined;
  }
  const known = modules.get(name);
  if (isBuiltinOnly) {
    return name === 'undici' ? undefined : known;
  }
  if (known !== undefined) {
    return known;
  }
  // exports can resolve a subpath inside its original package before legacy
  // path normalization; both possible package roots must be known transports.
  return transportPackages.has(name.replaceAll(path.sep, '/').split('/', 1).toString()) &&
    transportPackages.has(path.normalize(name).split(path.sep, 1).toString())
    ? transport
    : undefined;
}

export function member(
  origin: Origin | undefined,
  key: string | null | undefined,
): Origin | undefined {
  if (typeof key !== 'string') {
    return undefined;
  }
  return origin === exportsObject ? exportsObject : origin?.get(key);
}
