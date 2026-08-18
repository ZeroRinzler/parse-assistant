import { Provider } from '@angular/core';
import { DataFileApiService } from '../app/core/services/data-file-api';
import { TalentDataService } from '../app/core/services/talent-data';
import { WclApiService } from '../app/core/services/wcl-api';

export function provideApiFakes(fakes: { wcl: unknown; files?: unknown; talents?: unknown }): Provider[] {
  return [
    { provide: WclApiService, useValue: fakes.wcl as WclApiService },
    { provide: DataFileApiService, useValue: (fakes.files ?? {}) as DataFileApiService },
    ...(fakes.talents === undefined ? [] : [{ provide: TalentDataService, useValue: fakes.talents as TalentDataService }]),
  ];
}
