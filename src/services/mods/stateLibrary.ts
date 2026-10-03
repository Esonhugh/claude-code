// Evaluated inside each Mod's VM; no host functions cross the module boundary.
export const modStateLibrarySource = String.raw`
const ATOM_BRAND = Symbol.for('claude-code.state.atom');
const DERIVED_BRAND = Symbol.for('claude-code.state.derived');

function frozenRef(ref, id = ref.id) {
  const { plugin, key } = ref;
  return Object.freeze(id === undefined ? { plugin, key } : { plugin, key, id });
}

function deepFrozen(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFrozen(member);
  return Object.freeze(value);
}

export const atom = (ref, initial, options) => Object.freeze({
  [ATOM_BRAND]: true,
  ref: frozenRef(ref),
  initial: deepFrozen(initial),
  ...(options?.shape !== undefined && { shape: options.shape }),
});

const hasBrand = (source, brand) => typeof source === 'object' &&
  source !== null && source[brand] !== undefined;
const isAtom = source => hasBrand(source, ATOM_BRAND);
const isDerived = source => hasBrand(source, DERIVED_BRAND);

export const memberOf = (family, event) => isAtom(family)
  ? Object.freeze({ ...family, [ATOM_BRAND]: true, ref: frozenRef(family.ref, event.requestId) })
  : frozenRef(family, event.requestId);

function atomValueOf(atom, stored) {
  if (atom.shape === undefined) return stored === undefined ? atom.initial : stored;
  return stored?.shape === atom.shape && stored.value !== undefined ? stored.value : atom.initial;
}

async function peek(state, source) {
  if (isAtom(source)) {
    const held = await state.get(source.ref);
    return { value: atomValueOf(source, held.value), versions: [held.version] };
  }
  if (!isDerived(source)) {
    const held = await state.get(source);
    return { value: held.value, versions: [held.version] };
  }
  const parts = await Promise.all(source.sources.map(one => peek(state, one)));
  const versions = parts.flatMap(part => part.versions);
  const key = versions.join(',');
  const memo = source[DERIVED_BRAND];
  if (memo?.versions !== key && memo !== undefined) {
    memo.value = source.compute(...parts.map(part => part.value));
    memo.versions = key;
  }
  return { value: memo?.value, versions };
}

export const derive = (sources, compute) => {
  const memo = {};
  return Object.freeze({
    [DERIVED_BRAND]: memo,
    sources: Object.freeze(sources.map(one => isAtom(one) || isDerived(one) ? one : frozenRef(one))),
    compute,
  });
};

export const read = async ($, source) => (await peek($.state, source)).value;

export const update = async ($, target, change) => {
  const state = $.state;
  const ref = isAtom(target) ? target.ref : target;
  for (let tries = 0; tries < 64; tries += 1) {
    const held = await state.get(ref);
    const current = isAtom(target) ? atomValueOf(target, held.value) : held.value;
    const next = change(current);
    const stored = isAtom(target) && target.shape !== undefined
      ? { shape: target.shape, value: next } : next;
    const wrote = await state.set(ref, stored, { ifVersion: held.version });
    if (wrote.isSet) return next;
  }
  throw new Error('update: the value was written by another every time it was read, up ' +
    'to the bound on tries; nothing was written');
};
`
