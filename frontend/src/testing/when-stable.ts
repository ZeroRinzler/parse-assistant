import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';

/** Resolves once every load reported to `PendingTasks` has settled, so a fire-and-forget load is awaited rather than a tick guessed at. */
export function whenStable(): Promise<void> {
  return TestBed.inject(ApplicationRef).whenStable();
}
