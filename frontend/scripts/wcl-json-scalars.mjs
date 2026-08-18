// WCL types every payload field as one shared `JSON` scalar, and a single codegen `scalars` entry can only map that to one TypeScript type.

const JSON_FIELD_SCALARS = {
  'Report.playerDetails': 'PlayerDetailsJson',
  'Report.table': 'TableJson',
  'Encounter.characterRankings': 'RankingsJson',
  'ReportEventPaginator.data': 'EventDataJson',
};

const JSON_SCALAR = 'JSON';

function namedTypeRef(typeRef) {
  let ref = typeRef;
  while (ref.ofType) ref = ref.ofType;
  return ref;
}

function findField(types, typeName, fieldName) {
  const type = types.find(entry => entry.name === typeName);
  if (!type) throw new Error(`${typeName} is not in the WCL schema; update JSON_FIELD_SCALARS.`);
  const field = (type.fields ?? []).find(entry => entry.name === fieldName);
  if (!field) throw new Error(`${typeName}.${fieldName} is not in the WCL schema; update JSON_FIELD_SCALARS.`);
  return field;
}

export function nameJsonFieldScalars(introspection) {
  const types = introspection.__schema.types;
  const jsonScalar = types.find(entry => entry.kind === 'SCALAR' && entry.name === JSON_SCALAR);

  for (const [coordinate, scalarName] of Object.entries(JSON_FIELD_SCALARS)) {
    const [typeName, fieldName] = coordinate.split('.');
    const named = namedTypeRef(findField(types, typeName, fieldName).type);
    if (named.name !== JSON_SCALAR) {
      throw new Error(`${coordinate} is ${named.name}, not ${JSON_SCALAR}; update JSON_FIELD_SCALARS and the scalars map in scripts/schema-pull.mjs.`);
    }
    named.name = scalarName;
    types.push({
      ...jsonScalar,
      name: scalarName,
      description: `The \`${coordinate}\` payload. scripts/schema-pull.mjs maps this scalar to the app model that reads it.`,
    });
  }
  return introspection;
}
