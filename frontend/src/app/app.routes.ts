import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/post-raid/post-raid').then(m => m.PostRaidComponent),
  },
  {
    path: 'pre',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/pre-fight/pre-fight').then(m => m.PreFightComponent),
  },
  {
    path: 'live',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/live/live').then(m => m.LiveComponent),
  },
  {
    path: 'callback',
    loadComponent: () => import('./pages/callback/callback').then(m => m.CallbackComponent),
  },
  { path: '**', redirectTo: '' },
];
