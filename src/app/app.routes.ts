import { Routes } from '@angular/router';
import { ExamComponent } from './exam/exam.component';

export const routes: Routes = [
  {
    path: 'exam',
    component: ExamComponent
  },

  {
    path: '',
    redirectTo: 'exam',
    pathMatch: 'full'
  }
];