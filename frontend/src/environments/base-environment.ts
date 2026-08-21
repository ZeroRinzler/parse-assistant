import { WCL_PUBLIC_CLIENT_ID, WCL_PUBLIC_CLIENT_SECRET } from './wcl-public-client';

export interface Environment {
  dataBaseHref: string;
  ingest: boolean;
  wclClientId: string;
  wclClientSecret: string;
}

/** An empty `dataBaseHref` resolves `data/specs/` relative to `document.baseURI`. */
export function withEnvironment(deltas: Partial<Environment>): Environment {
  return {
    dataBaseHref: '',
    ingest: false,
    wclClientId: WCL_PUBLIC_CLIENT_ID,
    wclClientSecret: WCL_PUBLIC_CLIENT_SECRET,
    ...deltas,
  };
}
