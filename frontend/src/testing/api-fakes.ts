import { Provider } from '@angular/core';
import { DataFileApiService } from '../app/core/data-files/data-file-api-service';
import { TalentDataService } from '../app/core/http/talent-data-service';
import { WclApiService } from '../app/core/wcl/wcl-api-service';

export function provideApiFakes(fakes: { wcl: unknown; files?: unknown; talents?: unknown }): Provider[] {
  return [
    { provide: WclApiService, useValue: fakes.wcl as WclApiService },
    { provide: DataFileApiService, useValue: (fakes.files ?? {}) as DataFileApiService },
    ...(fakes.talents === undefined ? [] : [{ provide: TalentDataService, useValue: fakes.talents as TalentDataService }]),
  ];
}
