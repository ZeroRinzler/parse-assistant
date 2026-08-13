import { Routes } from '@angular/router';
import { PostRaidComponent } from './pages/post-raid/post-raid';

export const routes: Routes = [
  {
    // Lazy-loading the first-paint route would chain one more round trip behind main.js.
    path: '',
    component: PostRaidComponent,
  },
  {
    path: 'pre',
    loadComponent: () => import('./pages/pre-fight/pre-fight').then(m => m.PreFightComponent),
  },
  { path: '**', redirectTo: '' },
];
