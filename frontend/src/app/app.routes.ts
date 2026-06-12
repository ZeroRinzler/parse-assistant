import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/post-raid/post-raid').then(m => m.PostRaidComponent),
  },
  {
    path: 'pre',
    loadComponent: () => import('./pages/pre-fight/pre-fight').then(m => m.PreFightComponent),
  },
  {
    path: 'live',
    loadComponent: () => import('./pages/live/live').then(m => m.LiveComponent),
  },
  {
    path: 'callback',
    loadComponent: () => import('./pages/callback/callback').then(m => m.CallbackComponent),
  },
  { path: '**', redirectTo: '' },
];
