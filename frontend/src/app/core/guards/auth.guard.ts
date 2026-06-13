import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { WclAuthService } from '../services/wcl-auth';

export const authGuard: CanActivateFn = () => inject(WclAuthService).isLoggedIn();
