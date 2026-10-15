import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideOptimus } from '@openng/optimus-ui/config';
import Aura from '@openng/optimus-ui-themes/aura';
import { loadExamplesOnce } from './core/persistence/examples';
import { ProjectRepository } from './core/persistence/project-repository';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideOptimus({ theme: { preset: Aura, options: { darkModeSelector: '.app-dark' } } }),
    // The first run waits for the example projects, so it opens one; later runs don't wait.
    provideAppInitializer(() => loadExamplesOnce(inject(ProjectRepository))),
  ],
};
