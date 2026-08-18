import { codegen } from '@graphql-codegen/core';
import * as typescriptOperations from '@graphql-codegen/typescript-operations';
import { gqlPluckFromCodeString } from '@graphql-tools/graphql-tag-pluck';
import { buildClientSchema, getIntrospectionQuery, lexicographicSortSchema, parse, printSchema } from 'graphql';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WCL_PUBLIC_CLIENT_ID, WCL_PUBLIC_CLIENT_SECRET } from '../src/environments/wcl-public-client.ts';
import { nameJsonFieldScalars } from './wcl-json-scalars.mjs';

const SDL = fileURLToPath(new URL('../schema/wcl.graphql', import.meta.url));
const DOCUMENTS = fileURLToPath(new URL('../src/app/core/services/wcl-queries.ts', import.meta.url));
const TARGET = fileURLToPath(new URL('../src/app/core/services/wcl-operations.generated.ts', import.meta.url));

const CONFIG = {
  skipTypename: true,
  enumsAsTypes: true,
  strictScalars: true,
  scalars: {
    // `never` makes selecting a still-shared JSON field a compile error at the read site.
    JSON: 'never',
    PlayerDetailsJson: '../models/wcl.models#PlayerDetailsBlob',
    TableJson: '../models/wcl.models#WclTableBlob',
    RankingsJson: '../models/wcl.models#WclRankingsBlob',
    EventDataJson: '../models/wcl.models#WclEventData',
  },
};

async function post(url, headers, body) {
  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) throw new Error(`${url} responded ${response.status}: ${await response.text()}`);
  return response.json();
}

const { access_token } = await post('https://www.warcraftlogs.com/oauth/token', {},
  new URLSearchParams({ grant_type: 'client_credentials', client_id: WCL_PUBLIC_CLIENT_ID, client_secret: WCL_PUBLIC_CLIENT_SECRET }));
const { data, errors } = await post('https://www.warcraftlogs.com/api/v2/client', { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
  JSON.stringify({ query: getIntrospectionQuery({ descriptions: false }) }));
if (errors) throw new Error(`introspection responded 200 with errors: ${JSON.stringify(errors)}`);

// Sorted, so a re-introspection that only reshuffles WCL's type order leaves both outputs byte-identical.
const sdl = `${printSchema(lexicographicSortSchema(buildClientSchema(nameJsonFieldScalars(data))))}\n`;
await mkdir(dirname(SDL), { recursive: true });
await writeFile(SDL, sdl);

const plucked = await gqlPluckFromCodeString(DOCUMENTS, await readFile(DOCUMENTS, 'utf8'));

const output = await codegen({
  filename: TARGET,
  schema: parse(sdl),
  documents: [{ location: DOCUMENTS, document: parse(plucked.map(source => source.body).join('\n')) }],
  config: CONFIG,
  // Adding the `typescript` plugin alongside re-declares every enum `typescript-operations` already emits.
  plugins: [{ 'typescript-operations': {} }],
  pluginMap: { 'typescript-operations': typescriptOperations },
});

await writeFile(TARGET, output);
console.log(`Wrote ${SDL} and ${TARGET}`);
